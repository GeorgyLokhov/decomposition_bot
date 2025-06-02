const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const XLSX = require('xlsx');

const app = express();
const port = process.env.PORT || 10000;

// Конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://rozysk-avto-bot.onrender.com/webhook/${BOT_TOKEN}`;

// Создаем бота БЕЗ polling для продакшена
const bot = new TelegramBot(BOT_TOKEN, { 
  polling: false,
  request: {
    agentOptions: {
      keepAlive: true,
      family: 4
    }
  }
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Состояния пользователей
const userStates = new Map();
const userData = new Map();

// Константы состояний
const STATES = {
  IDLE: 'idle',
  WAITING_FILE: 'waiting_file',
  ASKING_FILTERS: 'asking_filters',
  SELECTING_ADDRESS_TYPE: 'selecting_address_type',
  SELECTING_CAR_AGE: 'selecting_car_age',
  PROCESSING: 'processing'
};

// Список дальних городов и регионов для исключения
const DISTANT_CITIES_AND_REGIONS = [
  // Крупные города
  'новосибирск', 'екатеринбург', 'нижний новгород', 'казань', 'челябинск', 'омск', 'самара',
  'ростов-на-дону', 'уфа', 'красноярск', 'воронеж', 'пермь', 'волгоград', 'краснодар',
  'саратов', 'тюмень', 'тольятти', 'ижевск', 'барнаул', 'ульяновск', 'иркутск', 'хабаровск',
  'ярославль', 'владивосток', 'махачкала', 'томск', 'оренбург', 'кемерово', 'новокузнецк',
  'рязань', 'пенза', 'липецк', 'киров', 'чебоксары', 'калининград', 'брянск', 'курск',
  'иваново', 'магнитогорск', 'тверь', 'ставрополь', 'белгород', 'сочи', 'нижний тагил',
  
  // Регионы и области
  'алтайский край', 'амурская область', 'архангельская область', 'астраханская область',
  'белгородская область', 'брянская область', 'владимирская область', 'волгоградская область',
  'вологодская область', 'воронежская область', 'еврейская автономная область',
  'забайкальский край', 'ивановская область', 'иркутская область', 'кабардино-балкарская республика',
  'калининградская область', 'калужская область', 'камчатский край', 'карачаево-черкесская республика',
  'кемеровская область', 'кировская область', 'костромская область', 'краснодарский край',
  'красноярский край', 'курганская область', 'курская область', 'ленинградская область',
  'липецкая область', 'магаданская область', 'мурманская область', 'нижегородская область',
  'новгородская область', 'новосибирская область', 'омская область', 'оренбургская область',
  'орловская область', 'пензенская область', 'пермский край', 'приморский край',
  'псковская область', 'республика адыгея', 'республика алтай', 'республика башкортостан',
  'республика бурятия', 'республика дагестан', 'республика ингушетия', 'республика калмыкия',
  'республика карелия', 'республика коми', 'республика крым', 'республика марий эл',
  'республика мордовия', 'республика саха', 'республика северная осетия', 'республика татарстан',
  'республика тыва', 'республика удмуртия', 'республика хакасия', 'республика чечня',
  'республика чувашия', 'ростовская область', 'рязанская область', 'самарская область',
  'саратовская область', 'сахалинская область', 'свердловская область', 'смоленская область',
  'тамбовская область', 'тверская область', 'томская область', 'тульская область',
  'тюменская область', 'ульяновская область', 'хабаровский край', 'ханты-мансийский автономный округ',
  'челябинская область', 'чукотский автономный округ', 'ямало-ненецкий автономный округ',
  'ярославская область',
  
  // Сокращения
  'нижегородская обл', 'свердловская обл', 'челябинская обл', 'новосибирская обл',
  'красноярский кр', 'пермский кр', 'краснодарский кр', 'алтайский кр'
];

// Устанавливаем webhook
async function setupWebhook() {
  try {
    await bot.setWebHook(WEBHOOK_URL);
    console.log('✅ Webhook установлен:', WEBHOOK_URL);
  } catch (error) {
    console.error('❌ Ошибка установки webhook:', error);
  }
}

// Определяем тип файла
function getFileType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  return ext;
}

// Проверяем поддерживаемые форматы
function isSupportedFile(filename) {
  const supportedTypes = ['csv', 'xlsx', 'xls'];
  const fileType = getFileType(filename);
  return supportedTypes.includes(fileType);
}

// Конвертируем Excel в CSV на сервере
function convertExcelToCSV(buffer, fileName) {
  try {
    console.log('Converting Excel to CSV on server...');
    
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const csvContent = XLSX.utils.sheet_to_csv(worksheet);
    
    console.log('Excel converted to CSV successfully, length:', csvContent.length);
    return csvContent;
    
  } catch (error) {
    console.error('Error converting Excel to CSV:', error);
    throw new Error('Не удалось конвертировать Excel файл: ' + error.message);
  }
}

// Проверяем, содержит ли адрес дальний город или регион
function containsDistantCity(address) {
  if (!address) return false;
  
  const addressLower = address.toLowerCase();
  
  // Паттерны для поиска городов и регионов
  const cityPatterns = [
    /г\.?\s*([а-яё\-\s]+)/gi,           // г. Название, г Название
    /город\s+([а-яё\-\s]+)/gi,         // город Название
    /([а-яё\-\s]+)\s+область/gi,       // Название область
    /([а-яё\-\s]+)\s+край/gi,          // Название край
    /([а-яё\-\s]+)\s+республика/gi,    // Название республика
    /республика\s+([а-яё\-\s]+)/gi,    // республика Название
    /([а-яё\-\s]+)\s+обл\.?/gi,        // Название обл
    /([а-яё\-\s]+)\s+кр\.?/gi,         // Название кр
    /,\s*([а-яё\-\s]+)(?=,|$)/gi       // , Название (между запятыми или в конце)
  ];
  
  const foundCities = new Set();
  
  // Извлекаем все потенциальные названия городов/регионов
  cityPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(addressLower)) !== null) {
      const cityName = match[1].trim().replace(/\s+/g, ' ');
      if (cityName.length > 2) { // игнорируем слишком короткие названия
        foundCities.add(cityName);
      }
    }
  });
  
  // Проверяем каждое найденное название
  for (const cityName of foundCities) {
    // Проверяем точное совпадение или вхождение в список дальних городов
    for (const distantCity of DISTANT_CITIES_AND_REGIONS) {
      if (cityName === distantCity || cityName.includes(distantCity) || distantCity.includes(cityName)) {
        // Дополнительная проверка: это не название улицы
        if (!isStreetName(addressLower, cityName)) {
          console.log(`Found distant city/region: ${cityName} in address: ${address}`);
          return true;
        }
      }
    }
  }
  
  return false;
}

// Проверяем, является ли найденное название улицей
function isStreetName(addressLower, cityName) {
  const streetIndicators = [
    'ул', 'улица', 'пр-кт', 'проспект', 'б-р', 'бульвар', 'пер', 'переулок',
    'ш', 'шоссе', 'наб', 'набережная', 'пл', 'площадь', 'тупик', 'проезд'
  ];
  
  // Ищем индикаторы улицы рядом с названием города
  const cityIndex = addressLower.indexOf(cityName);
  if (cityIndex === -1) return false;
  
  // Проверяем текст до и после названия города
  const before = addressLower.substring(Math.max(0, cityIndex - 20), cityIndex);
  const after = addressLower.substring(cityIndex + cityName.length, cityIndex + cityName.length + 20);
  
  for (const indicator of streetIndicators) {
    if (before.includes(indicator) || after.includes(indicator)) {
      return true;
    }
  }
  
  return false;
}

// Парсим CSV и извлекаем уникальные значения
function parseCSVAndExtractValues(csvContent) {
  const lines = csvContent.split(/\r\n|\n|\r/);
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  
  // Находим индексы нужных колонок
  const addressTypeIndex = headers.findIndex(h => 
    h.toLowerCase().includes('тип адреса') || h.toLowerCase().includes('type')
  );
  
  const carAgeIndex = headers.findIndex(h => 
    h.toLowerCase().includes('флаг нового авто') || h.toLowerCase().includes('flag')
  );
  
  const regionIndex = headers.findIndex(h => 
    h.toLowerCase().includes('регион') || h.toLowerCase().includes('region')
  );
  
  console.log('Column indices:', { addressTypeIndex, carAgeIndex, regionIndex });
  
  // Извлекаем уникальные значения
  const addressTypes = new Set();
  const carAges = new Set();
  const regions = new Set();
  
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    
    const row = parseCSVRow(lines[i]);
    
    if (addressTypeIndex !== -1 && row[addressTypeIndex]) {
      addressTypes.add(row[addressTypeIndex].trim());
    }
    
    if (carAgeIndex !== -1 && row[carAgeIndex]) {
      carAges.add(row[carAgeIndex].trim());
    }
    
    if (regionIndex !== -1 && row[regionIndex]) {
      regions.add(row[regionIndex].trim());
    }
  }
  
  return {
    addressTypes: Array.from(addressTypes).filter(v => v && v !== ''),
    carAges: Array.from(carAges).filter(v => v && v !== ''),
    regions: Array.from(regions).filter(v => v && v !== ''),
    headers,
    addressTypeIndex,
    carAgeIndex,
    regionIndex
  };
}

// Парсим строку CSV с учетом кавычек
function parseCSVRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

// ИСПРАВЛЕННАЯ ФУНКЦИЯ: Фильтрация данных по регионам через анализ адресов
function filterByRegion(csvContent) {
  const lines = csvContent.split(/\r\n|\n|\r/);
  const headers = lines[0];
  const filteredLines = [headers];
  
  // Ищем колонку с адресами
  const headerArray = headers.split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
  const addressIndex = headerArray.findIndex(h => 
    h.includes('адрес') || h.includes('address') || h.includes('местонахождение') || h.includes('location')
  );
  
  console.log('Address column index:', addressIndex);
  console.log('Headers:', headerArray);
  
  if (addressIndex === -1) {
    console.log('Address column not found, returning original data');
    return csvContent;
  }
  
  let totalRows = 0;
  let filteredRows = 0;
  let excludedRows = 0;
  
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    
    totalRows++;
    const row = parseCSVRow(lines[i]);
    const address = row[addressIndex] ? row[addressIndex].trim() : '';
    
    // Проверяем, содержит ли адрес дальний город или регион
    if (containsDistantCity(address)) {
      excludedRows++;
      console.log(`Excluding row with distant city: ${address}`);
      continue; // Исключаем эту строку
    }
    
    filteredRows++;
    filteredLines.push(lines[i]);
  }
  
  console.log(`Region filtering results:`);
  console.log(`Total rows processed: ${totalRows}`);
  console.log(`Rows kept: ${filteredRows}`);
  console.log(`Rows excluded: ${excludedRows}`);
  
  return filteredLines.join('\n');
}

// Применение фильтров к CSV
function applyFilters(csvContent, selectedAddressTypes, selectedCarAges, columnInfo) {
  const lines = csvContent.split(/\r\n|\n|\r/);
  const headers = lines[0];
  const filteredLines = [headers];
  
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    
    const row = parseCSVRow(lines[i]);
    let includeRow = true;
    
    // Фильтр по типу адреса
    if (selectedAddressTypes.length > 0 && columnInfo.addressTypeIndex !== -1) {
      const addressType = row[columnInfo.addressTypeIndex] ? row[columnInfo.addressTypeIndex].trim() : '';
      if (!selectedAddressTypes.includes(addressType)) {
        includeRow = false;
      }
    }
    
    // Фильтр по возрасту авто
    if (selectedCarAges.length > 0 && columnInfo.carAgeIndex !== -1) {
      const carAge = row[columnInfo.carAgeIndex] ? row[columnInfo.carAgeIndex].trim() : '';
      if (!selectedCarAges.includes(carAge)) {
        includeRow = false;
      }
    }
    
    if (includeRow) {
      filteredLines.push(lines[i]);
    }
  }
  
  console.log(`Applied filters: ${lines.length - 1} -> ${filteredLines.length - 1} rows`);
  return filteredLines.join('\n');
}

// Отправляем CSV на обработку в Apps Script
async function processCSVInAppsScript(csvContent, fileName) {
  try {
    console.log(`Sending CSV to Apps Script: ${fileName}, length: ${csvContent.length}`);
    
    const base64Content = Buffer.from(csvContent, 'utf8').toString('base64');
    
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: 'process_csv',
      csvContent: base64Content,
      fileName: fileName
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 300000
    });

    console.log('Apps Script response received');
    return response.data;
  } catch (error) {
    console.error('Error processing CSV in Apps Script:', error);
    throw new Error('Ошибка обработки в Google Apps Script. Попробуйте еще раз.');
  }
}

// Отправка файла с правильным MIME типом
async function sendDocumentSafe(chatId, buffer, filename) {
  try {
    console.log(`Sending document: ${filename}, size: ${buffer.length} bytes`);
    
    await bot.sendDocument(chatId, buffer, {
      caption: `📄 ${filename}`
    }, {
      filename: filename,
      contentType: 'text/csv'
    });
    
    console.log('Document sent successfully');
    
  } catch (error) {
    console.error('Error sending document:', error);
    throw error;
  }
}

// Создание inline клавиатуры для выбора типов адресов
function createAddressTypeKeyboard(addressTypes, selectedTypes = []) {
  const keyboard = [];
  
  for (let i = 0; i < addressTypes.length; i += 2) {
    const row = [];
    
    // Первая кнопка в ряду
    const type1 = addressTypes[i];
    const isSelected1 = selectedTypes.includes(type1);
    row.push({
      text: `${isSelected1 ? '✅' : '⬜'} ${type1}`,
      callback_data: `addr_${i}`
    });
    
    // Вторая кнопка в ряду (если есть)
    if (i + 1 < addressTypes.length) {
      const type2 = addressTypes[i + 1];
      const isSelected2 = selectedTypes.includes(type2);
      row.push({
        text: `${isSelected2 ? '✅' : '⬜'} ${type2}`,
        callback_data: `addr_${i + 1}`
      });
    }
    
    keyboard.push(row);
  }
  
  // Кнопки управления
  keyboard.push([
    { text: '🔄 Сбросить все', callback_data: 'addr_clear' },
    { text: '✅ Выбрать все', callback_data: 'addr_all' }
  ]);
  
  keyboard.push([
    { text: '⬅️ Назад', callback_data: 'back_to_filters' },
    { text: '➡️ Далее', callback_data: 'next_to_car_age' }
  ]);
  
  return { inline_keyboard: keyboard };
}

// Создание inline клавиатуры для выбора возраста авто
function createCarAgeKeyboard(carAges, selectedAges = []) {
  const keyboard = [];
  
  for (let i = 0; i < carAges.length; i += 2) {
    const row = [];
    
    const age1 = carAges[i];
    const isSelected1 = selectedAges.includes(age1);
    row.push({
      text: `${isSelected1 ? '✅' : '⬜'} ${age1}`,
      callback_data: `age_${i}`
    });
    
    if (i + 1 < carAges.length) {
      const age2 = carAges[i + 1];
      const isSelected2 = selectedAges.includes(age2);
      row.push({
        text: `${isSelected2 ? '✅' : '⬜'} ${age2}`,
        callback_data: `age_${i + 1}`
      });
    }
    
    keyboard.push(row);
  }
  
  keyboard.push([
    { text: '🔄 Сбросить все', callback_data: 'age_clear' },
    { text: '✅ Выбрать все', callback_data: 'age_all' }
  ]);
  
  keyboard.push([
    { text: '⬅️ Назад', callback_data: 'back_to_address' },
    { text: '🎯 Применить фильтры', callback_data: 'apply_filters' }
  ]);
  
  return { inline_keyboard: keyboard };
}

// Обработчик команды /start
async function handleStart(chatId) {
  userStates.set(chatId, STATES.IDLE);
  userData.delete(chatId);
  
  const welcomeMessage = `
🚗 **Добро пожаловать в Rozysk Avto Bot v6.1!**

Этот бот поможет вам обработать файлы для розыска автомобилей:

✅ **Основные функции:**
• Очищать адреса от лишней информации
• Извлекать номерные знаки из данных авто
• Разделять большие файлы на части по 2000 строк
• Добавлять геопривязку для карт

🎯 **Умная фильтрация:**
• Автоматическое исключение дальних регионов
• Сохранение адресов с названиями улиц (Челябинская ул., Волгоградский пр-кт)
• Исключение только городов и областей вне Московского региона
• Выбор типов адресов и возраста автомобилей

📎 **Поддерживаемые форматы:**
• CSV (.csv)
• Excel (.xlsx, .xls)

📤 **Просто отправьте мне файл для обработки!**
  `;
  
  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
}

// Обработчик документов
async function handleDocument(chatId, document) {
  const fileName = document.file_name;
  const fileSize = document.file_size;

  console.log(`Processing document: ${fileName}, size: ${fileSize} bytes`);

  try {
    if (!isSupportedFile(fileName)) {
      await bot.sendMessage(chatId, '❌ Поддерживаются только файлы: CSV, Excel (.xlsx, .xls)');
      return;
    }

    const processingMsg = await bot.sendMessage(chatId, '⏳ Загружаю файл...');

    const fileInfo = await bot.getFile(document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;

    await bot.editMessageText('📥 Загружаю файл...', {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });

    const response = await axios.get(fileUrl, { 
      responseType: 'arraybuffer',
      timeout: 60000
    });

    const fileBuffer = Buffer.from(response.data);
    const fileType = getFileType(fileName);
    let csvContent;

    if (fileType === 'csv') {
      csvContent = fileBuffer.toString('utf8');
    } else {
      await bot.editMessageText('🔄 Конвертирую Excel в CSV...', {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
      
      csvContent = convertExcelToCSV(fileBuffer, fileName);
    }

    await bot.editMessageText('🌍 Анализирую адреса и исключаю дальние регионы...', {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });

    // Фильтруем по регионам через анализ адресов
    const filteredByCityContent = filterByRegion(csvContent);

    await bot.editMessageText('📊 Анализирую данные для фильтров...', {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });

    // Извлекаем уникальные значения
    const columnInfo = parseCSVAndExtractValues(filteredByCityContent);

    // Сохраняем данные пользователя
    userData.set(chatId, {
      fileName,
      originalCsvContent: csvContent,
      filteredCsvContent: filteredByCityContent,
      columnInfo,
      selectedAddressTypes: [],
      selectedCarAges: []
    });

    await bot.deleteMessage(chatId, processingMsg.message_id);

    // Получаем количество строк до и после фильтрации
    const originalRowsCount = csvContent.split('\n').length - 1;
    const filteredRowsCount = filteredByCityContent.split('\n').length - 1;

    // Спрашиваем о фильтрах
    const filterKeyboard = {
      inline_keyboard: [
        [
          { text: '🎯 Настроить фильтры', callback_data: 'setup_filters' },
          { text: '📤 Без фильтров', callback_data: 'no_filters' }
        ]
      ]
    };

    await bot.sendMessage(chatId, `
✅ **Файл загружен и обработан!**

📊 **Статистика фильтрации по регионам:**
• Исходных строк: ${originalRowsCount}
• После исключения дальних регионов: ${filteredRowsCount}
• Исключено строк: ${originalRowsCount - filteredRowsCount}

🎯 **Дополнительные фильтры:**
• Найдено типов адресов: ${columnInfo.addressTypes.length}
• Найдено вариантов возраста авто: ${columnInfo.carAges.length}

🎯 **Выберите действие:**
    `, { 
      parse_mode: 'Markdown',
      reply_markup: filterKeyboard
    });

    userStates.set(chatId, STATES.ASKING_FILTERS);

  } catch (error) {
    console.error('Error processing document:', error);
    await bot.sendMessage(chatId, `❌ ${error.message}`);
  }
}

// Обработчик callback запросов
async function handleCallbackQuery(query) {
  const chatId = query.message.chat.id;
  const data = query.data;
  const messageId = query.message.message_id;
  
  try {
    await bot.answerCallbackQuery(query.id);
    
    const userInfo = userData.get(chatId);
    if (!userInfo) {
      await bot.editMessageText('❌ Данные сессии утеряны. Загрузите файл заново.', {
        chat_id: chatId,
        message_id: messageId
      });
      return;
    }

    if (data === 'no_filters') {
      // Обработка без фильтров
      await processAndSendFiles(chatId, userInfo.filteredCsvContent, userInfo.fileName, messageId);
      
    } else if (data === 'setup_filters') {
      // Переход к настройке фильтров
      userStates.set(chatId, STATES.SELECTING_ADDRESS_TYPE);
      
      const keyboard = createAddressTypeKeyboard(userInfo.columnInfo.addressTypes, userInfo.selectedAddressTypes);
      
      await bot.editMessageText(`
🎯 **Выберите типы адресов:**

Доступные варианты: ${userInfo.columnInfo.addressTypes.join(', ')}

Выберите нужные типы адресов (можно несколько):
      `, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      
    } else if (data.startsWith('addr_')) {
      // Обработка выбора типов адресов
      await handleAddressTypeSelection(chatId, data, messageId, userInfo);
      
    } else if (data.startsWith('age_')) {
      // Обработка выбора возраста авто
      await handleCarAgeSelection(chatId, data, messageId, userInfo);
      
    } else if (data === 'back_to_filters') {
      // Возврат к выбору фильтров
      const filterKeyboard = {
        inline_keyboard: [
          [
            { text: '🎯 Настроить фильтры', callback_data: 'setup_filters' },
            { text: '📤 Без фильтров', callback_data: 'no_filters' }
          ]
        ]
      };
      
      await bot.editMessageText(`
✅ **Файл готов к обработке!**

🎯 **Выберите действие:**
      `, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: filterKeyboard
      });
      
    } else if (data === 'next_to_car_age') {
      // Переход к выбору возраста авто
      userStates.set(chatId, STATES.SELECTING_CAR_AGE);
      
      const keyboard = createCarAgeKeyboard(userInfo.columnInfo.carAges, userInfo.selectedCarAges);
      
      await bot.editMessageText(`
🚗 **Выберите старое/новое авто:**

Доступные варианты: ${userInfo.columnInfo.carAges.join(', ')}

Выберите нужные варианты:
      `, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      
    } else if (data === 'back_to_address') {
      // Возврат к выбору типов адресов
      userStates.set(chatId, STATES.SELECTING_ADDRESS_TYPE);
      
      const keyboard = createAddressTypeKeyboard(userInfo.columnInfo.addressTypes, userInfo.selectedAddressTypes);
      
      await bot.editMessageText(`
🎯 **Выберите типы адресов:**

Доступные варианты: ${userInfo.columnInfo.addressTypes.join(', ')}

Выберите нужные типы адресов (можно несколько):
      `, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      
    } else if (data === 'apply_filters') {
      // Применение фильтров и обработка
      const filteredContent = applyFilters(
        userInfo.filteredCsvContent, 
        userInfo.selectedAddressTypes,
        userInfo.selectedCarAges,
        userInfo.columnInfo
      );
      
      if (filteredContent.split('\n').length <= 1) {
        await bot.editMessageText('❌ После применения фильтров не осталось данных. Попробуйте изменить настройки.', {
          chat_id: chatId,
          message_id: messageId
        });
        return;
      }
      
      await processAndSendFiles(chatId, filteredContent, userInfo.fileName, messageId, true);
      
    } else if (data === 'reselect_filters') {
      // Повторный выбор фильтров
      userInfo.selectedAddressTypes = [];
      userInfo.selectedCarAges = [];
      userData.set(chatId, userInfo);
      
      const filterKeyboard = {
        inline_keyboard: [
          [
            { text: '🎯 Настроить фильтры', callback_data: 'setup_filters' },
            { text: '📤 Без фильтров', callback_data: 'no_filters' }
          ]
        ]
      };
      
      await bot.sendMessage(chatId, `
🔄 **Перевыбор фильтров**

🎯 **Выберите действие:**
      `, { 
        parse_mode: 'Markdown',
        reply_markup: filterKeyboard
      });
    }
    
  } catch (error) {
    console.error('Error handling callback query:', error);
    await bot.answerCallbackQuery(query.id, { text: 'Произошла ошибка' });
  }
}

// Обработка выбора типов адресов
async function handleAddressTypeSelection(chatId, data, messageId, userInfo) {
  if (data === 'addr_clear') {
    userInfo.selectedAddressTypes = [];
  } else if (data === 'addr_all') {
    userInfo.selectedAddressTypes = [...userInfo.columnInfo.addressTypes];
  } else {
    const index = parseInt(data.replace('addr_', ''));
    const addressType = userInfo.columnInfo.addressTypes[index];
    
    if (userInfo.selectedAddressTypes.includes(addressType)) {
      userInfo.selectedAddressTypes = userInfo.selectedAddressTypes.filter(t => t !== addressType);
    } else {
      userInfo.selectedAddressTypes.push(addressType);
    }
  }
  
  userData.set(chatId, userInfo);
  
  const keyboard = createAddressTypeKeyboard(userInfo.columnInfo.addressTypes, userInfo.selectedAddressTypes);
  
  await bot.editMessageReplyMarkup(keyboard, {
    chat_id: chatId,
    message_id: messageId
  });
}

// Обработка выбора возраста авто
async function handleCarAgeSelection(chatId, data, messageId, userInfo) {
  if (data === 'age_clear') {
    userInfo.selectedCarAges = [];
  } else if (data === 'age_all') {
    userInfo.selectedCarAges = [...userInfo.columnInfo.carAges];
  } else {
    const index = parseInt(data.replace('age_', ''));
    const carAge = userInfo.columnInfo.carAges[index];
    
    if (userInfo.selectedCarAges.includes(carAge)) {
      userInfo.selectedCarAges = userInfo.selectedCarAges.filter(a => a !== carAge);
    } else {
      userInfo.selectedCarAges.push(carAge);
    }
  }
  
  userData.set(chatId, userInfo);
  
  const keyboard = createCarAgeKeyboard(userInfo.columnInfo.carAges, userInfo.selectedCarAges);
  
  await bot.editMessageReplyMarkup(keyboard, {
    chat_id: chatId,
    message_id: messageId
  });
}

// Обработка и отправка файлов
async function processAndSendFiles(chatId, csvContent, fileName, messageId, withFilters = false) {
  try {
    await bot.editMessageText('☁️ Обрабатываю данные в облаке...', {
      chat_id: chatId,
      message_id: messageId
    });

    const result = await processCSVInAppsScript(csvContent, fileName);

    if (result.success) {
      await bot.deleteMessage(chatId, messageId);

      const filterInfo = withFilters ? '\n🎯 **С примененными фильтрами**' : '\n📤 **Только с региональной фильтрацией**';
      
      const resultMessage = `
✅ **Файл успешно обработан!**${filterInfo}

📊 **Статистика:**
• Всего строк: ${result.totalRows}
• Создано частей: ${result.partsCount}

📁 **Отправляю обработанные файлы...**
      `;

      await bot.sendMessage(chatId, resultMessage, { parse_mode: 'Markdown' });

      const instructionMessage = `
💡 **Инструкция по использованию:**

1. Сохраните полученные файлы на свое устройство
2. Перейдите в Google My Maps (mymaps.google.com)
3. Создайте новую карту
4. Загружайте каждый файл по отдельности для получения меток на карте
5. Адреса автоматически преобразуются в точки на карте

🎯 **Каждый файл содержит до 2000 записей для оптимальной работы с картами**
      `;

      await bot.sendMessage(chatId, instructionMessage, { parse_mode: 'Markdown' });

      // Отправляем файлы
      for (let i = 0; i < result.files.length; i++) {
        const file = result.files[i];
        const buffer = Buffer.from(file.content, 'base64');
        
        await sendDocumentSafe(chatId, buffer, file.name);

        if (i < result.files.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }

      // Кнопка для повторного выбора фильтров
      const reselectionKeyboard = {
        inline_keyboard: [
          [
            { text: '🔄 Перевыбрать фильтры', callback_data: 'reselect_filters' }
          ]
        ]
      };

      await bot.sendMessage(chatId, '🎉 Все файлы отправлены! Можете загружать их в Google My Maps.', {
        reply_markup: reselectionKeyboard
      });

    } else {
      await bot.editMessageText(`❌ Ошибка обработки: ${result.error}`, {
        chat_id: chatId,
        message_id: messageId
      });
    }

  } catch (error) {
    console.error('Error processing and sending files:', error);
    await bot.sendMessage(chatId, `❌ ${error.message}`);
  }
}

// Обработчик других сообщений
async function handleMessage(chatId, text) {
  if (text && !text.startsWith('/')) {
    await bot.sendMessage(chatId, '📎 Отправьте файл для обработки (CSV или Excel)');
  }
}

// Webhook endpoint для получения обновлений от Telegram
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  try {
    const update = req.body;
    
    if (update.message) {
      const chatId = update.message.chat.id;
      const message = update.message;

      console.log('Received message from chat:', chatId);

      if (message.text === '/start') {
        await handleStart(chatId);
      } else if (message.document) {
        await handleDocument(chatId, message.document);
      } else if (message.text) {
        await handleMessage(chatId, message.text);
      }
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).send('OK');
  }
});

// Основные routes
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Rozysk Avto Bot v6.1</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 50px; text-align: center; background: #f0f0f0; }
        .container { max-width: 700px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .status { color: #4CAF50; font-size: 24px; font-weight: bold; }
        .info { color: #666; margin-top: 20px; line-height: 1.6; }
        .version { background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0; }
        .features { background: #f3e5f5; padding: 15px; border-radius: 5px; margin: 10px 0; }
        .smart { background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 10px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚗 Rozysk Avto Bot</h1>
        <div class="status">✅ Сервис работает!</div>
        <div class="version">
          <strong>Версия 6.1 - Умная фильтрация адресов</strong><br>
          • Интеллектуальный анализ адресов<br>
          • Исключение дальних городов и регионов<br>
          • Сохранение названий улиц<br>
          • Система фильтров по типам и возрасту авто
        </div>
        <div class="smart">
          <strong>🧠 Умная фильтрация:</strong><br>
          • Исключает: "г. Новосибирск", "Челябинская область"<br>
          • Сохраняет: "ул. Челябинская", "Волгоградский пр-кт"<br>
          • Автоматически определяет названия городов<br>
          • Отличает улицы от городов по контексту
        </div>
        <div class="features">
          <strong>🎯 Возможности:</strong><br>
          • Множественный выбор фильтров<br>
          • Возможность работы без фильтров<br>
          • Кнопка "Назад" на каждом шаге<br>
          • Повторный выбор фильтров<br>
          • Подробная статистика фильтрации
        </div>
        <div class="info">
          <p><strong>Telegram:</strong> <a href="https://t.me/rozysk_avto_bot">@rozysk_avto_bot</a></p>
          <p><strong>Поддерживаемые форматы:</strong> CSV, Excel (xlsx, xls)</p>
          <p><strong>Время работы:</strong> ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get('/doget', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Rozysk Avto Bot v6.1 with smart address filtering is running',
    webhook: WEBHOOK_URL,
    timestamp: new Date().toISOString(),
    features: [
      'Smart address analysis',
      'Distant city exclusion',
      'Street name preservation',
      'Address type filtering',
      'Car age filtering',
      'Interactive UI',
      'Context-aware filtering'
    ]
  });
});

app.post('/dopost', (req, res) => {
  res.json({ 
    status: 'ok', 
    received: req.body,
    timestamp: new Date().toISOString()
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Получен SIGTERM, завершаем работу...');
  try {
    await bot.deleteWebHook();
    console.log('Webhook удален');
  } catch (error) {
    console.error('Ошибка при удалении webhook:', error);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Получен SIGINT, завершаем работу...');
  try {
    await bot.deleteWebHook();
    console.log('Webhook удален');
  } catch (error) {
    console.error('Ошибка при удалении webhook:', error);
  }
  process.exit(0);
});

// Запуск сервера
app.listen(port, async () => {
  console.log(`🚀 Server v6.1 running on port ${port}`);
  console.log(`📡 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`🧠 Smart filtering: Address analysis, City exclusion, Street preservation`);
  
  await setupWebhook();
  
  console.log('✅ Telegram bot v6.1 with smart filtering is ready!');
});
