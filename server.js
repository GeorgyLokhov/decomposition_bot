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

// Список дальних городов и регионов для исключения (ТОЛЬКО города и регионы, БЕЗ названий улиц)
const DISTANT_CITIES_AND_REGIONS = [
  // Крупные города
  'новосибирск', 'екатеринбург', 'нижний новгород', 'казань', 'челябинск', 'омск', 'самара',
  'ростов-на-дону', 'ростов', 'уфа', 'красноярск', 'воронеж', 'пермь', 'волгоград', 'краснодар',
  'саратов', 'тюмень', 'тольятти', 'ижевск', 'барнаул', 'ульяновск', 'иркутск', 'хабаровск',
  'ярославль', 'владивосток', 'махачкала', 'томск', 'оренбург', 'кемерово', 'новокузнецк',
  'рязань', 'пенза', 'липецк', 'киров', 'чебоксары', 'калининград', 'брянск', 'курск',
  'иваново', 'магнитогорск', 'тверь', 'ставрополь', 'белгород', 'сочи', 'нижний тагил',
  'астрахань', 'владимир', 'архангельск', 'тула', 'смоленск', 'кострома', 'мурманск',
  
  // Регионы и области (БЕЗ "ская" и других окончаний улиц)
  'алтайский', 'амурская', 'архангельская', 'астраханская', 'белгородская', 'брянская',
  'владимирская', 'волгоградская', 'вологодская', 'воронежская', 'ивановская', 'иркутская',
  'калининградская', 'калужская', 'кемеровская', 'кировская', 'костромская', 'краснодарский',
  'красноярский', 'курганская', 'курская', 'ленинградская', 'липецкая', 'магаданская',
  'мурманская', 'нижегородская', 'новгородская', 'новосибирская', 'омская', 'оренбургская',
  'орловская', 'пензенская', 'пермский', 'приморский', 'псковская', 'ростовская',
  'рязанская', 'самарская', 'саратовская', 'сахалинская', 'свердловская', 'смоленская',
  'тамбовская', 'тверская', 'томская', 'тульская', 'тюменская', 'ульяновская',
  'хабаровский', 'челябинская', 'ярославская'
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

// ИСПРАВЛЕННАЯ ФУНКЦИЯ: Проверяем, содержит ли адрес дальний город или регион
function containsDistantCity(address) {
  if (!address) return false;
  
  const addressLower = address.toLowerCase();
  
  // Проверяем явные указания на города с префиксами
  const explicitCityPatterns = [
    /г\.?\s+([а-яё\-\s]+?)(?=,|$|\s+обл|\s+край)/gi,        // г. Название
    /город\s+([а-яё\-\s]+?)(?=,|$|\s+обл|\s+край)/gi,      // город Название
  ];
  
  // Проверяем области и края
  const regionPatterns = [
    /([а-яё\-\s]+?)\s+область/gi,           // Название область
    /([а-яё\-\s]+?)\s+обл\.?(?=,|$)/gi,     // Название обл.
    /([а-яё\-\s]+?)\s+край/gi,              // Название край  
    /([а-яё\-\s]+?)\s+кр\.?(?=,|$)/gi,      // Название кр.
    /([а-яё\-\s]+?)\s+республика/gi,        // Название республика
    /республика\s+([а-яё\-\s]+)/gi,         // республика Название
  ];
  
  // Объединяем все паттерны для поиска регионов
  const allRegionPatterns = [...explicitCityPatterns, ...regionPatterns];
  
  for (const pattern of allRegionPatterns) {
    let match;
    pattern.lastIndex = 0; // Сбрасываем индекс для корректной работы
    while ((match = pattern.exec(addressLower)) !== null) {
      const foundName = match[1].trim().replace(/\s+/g, ' ');
      
      if (foundName.length < 3) continue; // Слишком короткое название
      
      // Проверяем, есть ли это название в списке дальних регионов
      for (const distantRegion of DISTANT_CITIES_AND_REGIONS) {
        if (foundName === distantRegion || 
            foundName.includes(distantRegion) || 
            distantRegion.includes(foundName)) {
          console.log(`Found distant region: ${foundName} in address: ${address}`);
          return true;
        }
      }
    }
  }
  
  // Отдельная проверка для адресов без явных указателей города
  // Проверяем только если в адресе НЕТ указаний на Москву
  const hasMoscowIndicator = /москва|московская|мо|м\.о\./i.test(addressLower);
  
  if (!hasMoscowIndicator) {
    // Ищем названия городов в конце адреса или после запятых
    const cityInAddressPattern = /(?:^|,)\s*([а-яё\-\s]{4,})(?=,|$)/gi;
    
    let match;
    cityInAddressPattern.lastIndex = 0;
    while ((match = cityInAddressPattern.exec(addressLower)) !== null) {
      const potentialCity = match[1].trim();
      
      // Исключаем очевидные не-города
      if (potentialCity.includes('дом') || 
          potentialCity.includes('корп') || 
          potentialCity.includes('кв') ||
          potentialCity.includes('офис') ||
          potentialCity.includes('этаж') ||
          /\d/.test(potentialCity)) {
        continue;
      }
      
      // Проверяем в списке дальних городов
      for (const distantCity of DISTANT_CITIES_AND_REGIONS) {
        if (potentialCity === distantCity) {
          console.log(`Found distant city without Moscow indicator: ${potentialCity} in address: ${address}`);
          return true;
        }
      }
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
🚗 **Добро пожаловать в Rozysk Avto Bot v6.2!**

Этот бот поможет вам обработать файлы для розыска автомобилей:

✅ **Основные функции:**
• Очищать адреса от лишней информации
• Извлекать номерные знаки из данных авто
• Разделять большие файлы на части по 2000 строк
• Добавлять геопривязку для карт

🎯 **Умная фильтрация (исправлена):**
• Исключение дальних регионов и городов
• ✅ Сохранение московских улиц: "ул. Саратовская", "Волгоградский пр-кт"
• ❌ Исключение регионов: "г. Саратов", "Волгоградская область"
• Выбор типов адресов и возраста автомобилей

📎 **Поддерживаемые форматы:**
• CSV (.csv)
• Excel (.xlsx, .xls)

📤 **Просто отправьте мне файл для обработки!**
  `;
  
  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
}

// [ОСТАЛЬНЫЕ ФУНКЦИИ ОСТАЮТСЯ БЕЗ ИЗМЕНЕНИЙ - handleDocument, handleCallbackQuery, и т.д.]
// [Скопируйте их из предыдущей версии]

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

    await bot.editMessageText('🧠 Умная фильтрация: анализирую адреса...', {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });

    // Фильтруем по регионам через анализ адресов
    const filteredByCityContent = filterByRegion(csvContent);

    await bot.editMessageText('📊 Анализирую данные для дополнительных фильтров...', {
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
          { text: '📤 Без доп. фильтров', callback_data: 'no_filters' }
        ]
      ]
    };

    await bot.sendMessage(chatId, `
✅ **Файл загружен и обработан!**

🧠 **Умная фильтрация по регионам:**
• Исходных строк: ${originalRowsCount}
• ✅ Сохранено московских адресов: ${filteredRowsCount}
• ❌ Исключено дальних регионов: ${originalRowsCount - filteredRowsCount}

🎯 **Дополнительные фильтры:**
• Найдено типов адресов: ${columnInfo.addressTypes.length}
• Найдено вариантов возраста авто: ${columnInfo.carAges.length}

💡 **Сохранены:** ул. Саратовская, Волгоградский пр-кт
❌ **Исключены:** г. Саратов, Волгоградская область

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

// [ДОБАВЬТЕ ОСТАЛЬНЫЕ ФУНКЦИИ ИЗ ПРЕДЫДУЩЕЙ ВЕРСИИ:]
// - handleCallbackQuery
// - handleAddressTypeSelection  
// - handleCarAgeSelection
// - processAndSendFiles
// - handleMessage
// - webhook endpoint
// - основные routes
// - graceful shutdown
// - запуск сервера

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
      await processAndSendFiles(chatId, userInfo.filteredCsvContent, userInfo.fileName, messageId);
    } else if (data === 'setup_filters') {
      userStates.set(chatId, STATES.SELECTING_ADDRESS_TYPE);
      const keyboard = createAddressTypeKeyboard(userInfo.columnInfo.addressTypes, userInfo.selectedAddressTypes);
      await bot.editMessageText(`🎯 **Выберите типы адресов:**\n\nДоступные варианты: ${userInfo.columnInfo.addressTypes.join(', ')}\n\nВыберите нужные типы адресов (можно несколько):`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: keyboard
      });
    } else if (data.startsWith('addr_')) {
      await handleAddressTypeSelection(chatId, data, messageId, userInfo);
    } else if (data.startsWith('age_')) {
      await handleCarAgeSelection(chatId, data, messageId, userInfo);
    } else if (data === 'back_to_filters') {
      const filterKeyboard = { inline_keyboard: [[ { text: '🎯 Настроить фильтры', callback_data: 'setup_filters' }, { text: '📤 Без доп. фильтров', callback_data: 'no_filters' } ]] };
      await bot.editMessageText('✅ **Файл готов к обработке!**\n\n🎯 **Выберите действие:**', {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: filterKeyboard
      });
    } else if (data === 'next_to_car_age') {
      userStates.set(chatId, STATES.SELECTING_CAR_AGE);
      const keyboard = createCarAgeKeyboard(userInfo.columnInfo.carAges, userInfo.selectedCarAges);
      await bot.editMessageText(`🚗 **Выберите старое/новое авто:**\n\nДоступные варианты: ${userInfo.columnInfo.carAges.join(', ')}\n\nВыберите нужные варианты:`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: keyboard
      });
    } else if (data === 'back_to_address') {
      userStates.set(chatId, STATES.SELECTING_ADDRESS_TYPE);
      const keyboard = createAddressTypeKeyboard(userInfo.columnInfo.addressTypes, userInfo.selectedAddressTypes);
      await bot.editMessageText(`🎯 **Выберите типы адресов:**\n\nДоступные варианты: ${userInfo.columnInfo.addressTypes.join(', ')}\n\nВыберите нужные типы адресов (можно несколько):`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: keyboard
      });
    } else if (data === 'apply_filters') {
      const filteredContent = applyFilters(userInfo.filteredCsvContent, userInfo.selectedAddressTypes, userInfo.selectedCarAges, userInfo.columnInfo);
      if (filteredContent.split('\n').length <= 1) {
        await bot.editMessageText('❌ После применения фильтров не осталось данных. Попробуйте изменить настройки.', { chat_id: chatId, message_id: messageId });
        return;
      }
      await processAndSendFiles(chatId, filteredContent, userInfo.fileName, messageId, true);
    } else if (data === 'reselect_filters') {
      userInfo.selectedAddressTypes = []; userInfo.selectedCarAges = []; userData.set(chatId, userInfo);
      const filterKeyboard = { inline_keyboard: [[ { text: '🎯 Настроить фильтры', callback_data: 'setup_filters' }, { text: '📤 Без доп. фильтров', callback_data: 'no_filters' } ]] };
      await bot.sendMessage(chatId, '🔄 **Перевыбор фильтров**\n\n🎯 **Выберите действие:**', { parse_mode: 'Markdown', reply_markup: filterKeyboard });
    }
  } catch (error) {
    console.error('Error handling callback query:', error);
    await bot.answerCallbackQuery(query.id, { text: 'Произошла ошибка' });
  }
}

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
  await bot.editMessageReplyMarkup(keyboard, { chat_id: chatId, message_id: messageId });
}

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
  await bot.editMessageReplyMarkup(keyboard, { chat_id: chatId, message_id: messageId });
}

async function processAndSendFiles(chatId, csvContent, fileName, messageId, withFilters = false) {
  try {
    await bot.editMessageText('☁️ Обрабатываю данные в облаке...', { chat_id: chatId, message_id: messageId });
    const result = await processCSVInAppsScript(csvContent, fileName);
    if (result.success) {
      await bot.deleteMessage(chatId, messageId);
      const filterInfo = withFilters ? '\n🎯 **С примененными фильтрами**' : '\n🧠 **С умной региональной фильтрацией**';
      const resultMessage = `✅ **Файл успешно обработан!**${filterInfo}\n\n📊 **Статистика:**\n• Всего строк: ${result.totalRows}\n• Создано частей: ${result.partsCount}\n\n📁 **Отправляю обработанные файлы...**`;
      await bot.sendMessage(chatId, resultMessage, { parse_mode: 'Markdown' });
      const instructionMessage = '💡 **Инструкция по использованию:**\n\n1. Сохраните полученные файлы на свое устройство\n2. Перейдите в Google My Maps (mymaps.google.com)\n3. Создайте новую карту\n4. Загружайте каждый файл по отдельности для получения меток на карте\n5. Адреса автоматически преобразуются в точки на карте\n\n🎯 **Каждый файл содержит до 2000 записей для оптимальной работы с картами**';
      await bot.sendMessage(chatId, instructionMessage, { parse_mode: 'Markdown' });
      for (let i = 0; i < result.files.length; i++) {
        const file = result.files[i];
        const buffer = Buffer.from(file.content, 'base64');
        await sendDocumentSafe(chatId, buffer, file.name);
        if (i < result.files.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }
      const reselectionKeyboard = { inline_keyboard: [[ { text: '🔄 Перевыбрать фильтры', callback_data: 'reselect_filters' } ]] };
      await bot.sendMessage(chatId, '🎉 Все файлы отправлены! Можете загружать их в Google My Maps.', { reply_markup: reselectionKeyboard });
    } else {
      await bot.editMessageText(`❌ Ошибка обработки: ${result.error}`, { chat_id: chatId, message_id: messageId });
    }
  } catch (error) {
    console.error('Error processing and sending files:', error);
    await bot.sendMessage(chatId, `❌ ${error.message}`);
  }
}

async function handleMessage(chatId, text) {
  if (text && !text.startsWith('/')) {
    await bot.sendMessage(chatId, '📎 Отправьте файл для обработки (CSV или Excel)');
  }
}

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

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Rozysk Avto Bot v6.2</title><style>body { font-family: Arial, sans-serif; margin: 50px; text-align: center; background: #f0f0f0; } .container { max-width: 700px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); } .status { color: #4CAF50; font-size: 24px; font-weight: bold; } .info { color: #666; margin-top: 20px; line-height: 1.6; } .version { background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0; } .fix { background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 10px 0; }</style></head><body><div class="container"><h1>🚗 Rozysk Avto Bot</h1><div class="status">✅ Сервис работает!</div><div class="version"><strong>Версия 6.2 - Исправленная фильтрация</strong><br>• Умная фильтрация по регионам<br>• Исправлена логика определения улиц<br>• Точное исключение дальних городов<br>• Сохранение московских адресов</div><div class="fix"><strong>🔧 Исправления v6.2:</strong><br>• ✅ Сохраняет: "ул. Саратовская", "Волгоградский пр-кт"<br>• ❌ Исключает: "г. Саратов", "Саратовская область"<br>• Улучшена логика анализа адресов<br>• Точное определение городов vs улиц</div><div class="info"><p><strong>Telegram:</strong> <a href="https://t.me/rozysk_avto_bot">@rozysk_avto_bot</a></p><p><strong>Поддерживаемые форматы:</strong> CSV, Excel (xlsx, xls)</p><p><strong>Время работы:</strong> ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</p></div></div></body></html>`);
});

app.get('/doget', (req, res) => {
  res.json({ status: 'ok', message: 'Rozysk Avto Bot v6.2 with fixed smart filtering is running', webhook: WEBHOOK_URL, timestamp: new Date().toISOString(), features: ['Fixed smart address analysis', 'Proper street name preservation', 'Accurate distant city exclusion', 'Improved address vs city detection', 'Regional filtering', 'Address type filtering', 'Car age filtering'] });
});

app.post('/dopost', (req, res) => {
  res.json({ status: 'ok', received: req.body, timestamp: new Date().toISOString() });
});

process.on('SIGTERM', async () => { console.log('Получен SIGTERM, завершаем работу...'); try { await bot.deleteWebHook(); console.log('Webhook удален'); } catch (error) { console.error('Ошибка при удалении webhook:', error); } process.exit(0); });
process.on('SIGINT', async () => { console.log('Получен SIGINT, завершаем работу...'); try { await bot.deleteWebHook(); console.log('Webhook удален'); } catch (error) { console.error('Ошибка при удалении webhook:', error); } process.exit(0); });

app.listen(port, async () => {
  console.log(`🚀 Server v6.2 running on port ${port}`);
  console.log(`📡 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`🔧 Fixed filtering: Streets preserved, distant cities excluded`);
  await setupWebhook();
  console.log('✅ Telegram bot v6.2 with fixed smart filtering is ready!');
});
