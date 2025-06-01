const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN environment variable is required');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN);
app.use(express.json());

// Создаем папку uploads если она не существует
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Хранилище состояний пользователей
const userStates = new Map();
const userFiles = new Map();

// Московские регионы и близлежащие области
const MOSCOW_REGIONS = [
  'москва', 'московская область', 'подмосковье', 'калужская область',
  'тульская область', 'рязанская область', 'владимирская область',
  'смоленская область', 'тверская область', 'ярославская область',
  'балашиха', 'одинцово', 'подольск', 'королёв', 'мытищи', 'химки',
  'люберцы', 'коломна', 'электросталь', 'красногорск', 'сергиев посад',
  'щёлково', 'орехово-зуево', 'раменское', 'жуковский', 'пушкино',
  'железнодорожный', 'домодедово', 'видное', 'ивантеевка', 'фрязино',
  'лобня', 'клин', 'воскресенск', 'рошаль', 'кашира', 'чехов', 'дмитров',
  'ногинск', 'павловский посад', 'талдом', 'яхрома', 'красноармейск',
  'богородск', 'краснозаводск', 'загорск', 'солнечногорск', 'истра'
];

// Состояния пользователей
const STATES = {
  WAITING_FILE: 'waiting_file',
  CHOOSE_FILTERS: 'choose_filters',
  SELECT_ADDRESS_TYPE: 'select_address_type',
  SELECT_NEW_CAR_FLAG: 'select_new_car_flag',
  FILTERS_APPLIED: 'filters_applied'
};

// Инициализация состояния пользователя
function initUserState(chatId) {
  if (!userStates.has(chatId)) {
    userStates.set(chatId, {
      state: STATES.WAITING_FILE,
      selectedAddressTypes: new Set(),
      selectedNewCarFlags: new Set(),
      originalData: null,
      filteredData: null,
      addressTypes: [],
      newCarFlags: []
    });
  }
  return userStates.get(chatId);
}

// Очистка файлов пользователя
function cleanupUserFiles(chatId) {
  if (userFiles.has(chatId)) {
    const files = userFiles.get(chatId);
    files.forEach(file => {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (error) {
        console.error('Error deleting file:', error);
      }
    });
    userFiles.delete(chatId);
  }
}

// === ТВОИ ФУНКЦИИ ОБРАБОТКИ ===

// 1. Умная очистка адресов
function smartCleanAddress(address) {
  if (address === null || address === undefined || typeof address !== 'string') {
    return address;
  }

  address = String(address).trim();

  const patternsToRemove = [
    /,?\s*кв\.?\s*\d+/gi, /,?\s*квартира\s*\d+/gi,
    /,?\s*оф\.?\s*\d+/gi, /,?\s*офис\s*\d+/gi,
    /,?\s*эт\.?\s*\d+/gi, /,?\s*этаж\s*\d+/gi,
    /,?\s*пом\.?\s*\d+/gi, /,?\s*помещение\s*\d+/gi,
    /^\d{6},?\s*/gi,
  ];

  for (const pattern of patternsToRemove) {
    address = address.replace(pattern, '');
  }

  address = address.replace(/,+/g, ',');
  address = address.replace(/\s+/g, ' ');
  address = address.trim().replace(/^,|,$/g, ''); // Убираем запятые в начале и конце

  const hasCity = /\b(Москва|московская область|москва|мо|м\.о\.)\b/i.test(address);

  if (!hasCity) {
    const moIndicators = [
      /\b(балашиха|одинцово|подольск|королёв|мытищи|химки|люберцы|коломна|электросталь|красногорск|сергиев посад|щёлково|орехово-зуево|раменское|жуковский|пушкино|железнодорожный|домодедово|видное|ивантеевка|сергиев-посад|фрязино|лобня|клин|воскресенск|рошаль|кашира|чехов|дмитров|ногинск|павловский посад|талдом|яхрома|красноармейск|богородск|краснозаводск|загорск|солнечногорск|истра)\b/i,
      /\bг\.?\s*(балашиха|одинцово|подольск)/i,
      /\b(московская обл|мо)\b/i
    ];
    const isMo = moIndicators.some(pattern => pattern.test(address));
    address += isMo ? ', Московская область, Россия' : ', Москва, Россия';
  }
  return address;
}

// 2. Извлечение номерных знаков
function extractLicensePlate(text) {
  if (!text || typeof text !== 'string') {
    return "";
  }
  text = String(text); // Убедимся, что это строка

  const patterns = [
    /[А-Я]\d{3}[А-Я]{2}\d{2,3}/g,      // A123BC77, A123BC777
    /\d{4}[А-Я]{2}\d{2,3}/g,          // 1234AB77 (для прицепов и т.д.)
    /[А-Я]{1,2}\d{3,4}[А-Я]{1,2}\d{2,3}/g // Более общие случаи
  ];

  let foundPlates = [];
  for (const pattern of patterns) {
    const matches = text.toUpperCase().match(pattern);
    if (matches) {
      foundPlates = foundPlates.concat(matches);
    }
  }

  if (foundPlates.length > 0) {
    return foundPlates[0]; // Возвращаем первый найденный по основным шаблонам
  }

  // Эвристика из твоего кода для случаев, когда явных шаблонов нет
  const textCleanArray = text.replace(/\s/g, '').replace(/,/g, ' ').split(' ');
  const textClean = textCleanArray.length > 0 ? textCleanArray[textCleanArray.length - 1] : "";


  if (textClean && textClean.length >= 8) {
    const last3 = textClean.slice(-3);
    if (last3.length === 3) {
        const isDigit = (char) => /\d/.test(char);
        const isLetter = (char) => /[А-ЯA-Z]/i.test(char);

        if (isDigit(last3[0]) && isDigit(last3[1]) && isLetter(last3[2])) {
            return textClean.length >= 8 ? textClean.slice(-8) : textClean;
        } else if (isDigit(last3[0]) && isDigit(last3[1]) && isDigit(last3[2])) {
            return textClean.length >= 9 ? textClean.slice(-9) : textClean;
        }
    }
  }
  return "";
}

// ОСНОВНАЯ ФУНКЦИЯ ОБРАБОТКИ ДАННЫХ (включает твою логику)
function processRawData(data) {
  if (!data || data.length === 0) return [];

  // 1. Умная очистка адресов
  const addressColName = Object.keys(data[0]).find(col => /адрес|address/i.test(col));
  if (addressColName) {
    data.forEach(row => {
      row[addressColName] = smartCleanAddress(row[addressColName]);
    });
  }

  // 2. Извлечение номерных знаков В НОВЫЙ СТОЛБЕЦ и очистка старого
  const autoDataColName = Object.keys(data[0]).find(col => /данные авто/i.test(col));
  if (autoDataColName) {
    data.forEach(row => {
      const originalAutoData = String(row[autoDataColName] || "");
      const plate = extractLicensePlate(originalAutoData);
      
      row['НОМЕРНОЙ ЗНАК'] = plate; // Новый столбец
      
      if (plate) {
        let cleanedAutoData = originalAutoData.replace(plate, '').trim();
        cleanedAutoData = cleanedAutoData.replace(/^,\s*|\s*,$/g, '').trim();
        row[autoDataColName] = cleanedAutoData;
      }
    });
  }
  return data;
}

// Фильтрация по московским регионам (применяется ПОСЛЕ processRawData)
function filterMoscowRegions(data) {
  return data.filter(row => {
    const region = String(row['Регион'] || row['регион'] || row['РЕГИОН'] || '').toLowerCase();
    const city = String(row['Город'] || row['город'] || row['ГОРОД'] || '').toLowerCase();
    const address = String(row['Адрес'] || row['адрес'] || row['АДРЕС'] || '').toLowerCase();
    
    const fullLocation = `${region} ${city} ${address}`.toLowerCase();
    
    return MOSCOW_REGIONS.some(moscowRegion => 
      fullLocation.includes(moscowRegion) || 
      region.includes(moscowRegion) ||
      city.includes('москва') || 
      address.includes('москва') 
    );
  });
}

// Получение уникальных значений из столбца для фильтров
function getUniqueValues(data, columnName) {
  if (!data || data.length === 0) return [];
  const possibleColumnNames = [columnName, columnName.toLowerCase(), columnName.toUpperCase()];
  let actualColumnName = null;

  for (const name of possibleColumnNames) {
    if (data[0].hasOwnProperty(name)) {
      actualColumnName = name;
      break;
    }
  }
  if (!actualColumnName) return [];
  
  return [...new Set(data.map(row => row[actualColumnName]).filter(val => val !== undefined && val !== null && String(val).trim() !== ''))];
}

// Создание inline клавиатуры для выбора
function createSelectionKeyboard(options, selectedItems, callbackPrefix, backButton = true) {
  const keyboard = [];
  for (let i = 0; i < options.length; i += 2) {
    const row = [];
    const option1 = options[i];
    const isSelected1 = selectedItems.has(option1);
    row.push({
      text: `${isSelected1 ? '✅' : '◻️'} ${String(option1).slice(0, 25)}`, 
      callback_data: `${callbackPrefix}${Buffer.from(String(option1)).toString('base64')}`
    });
    if (i + 1 < options.length) {
      const option2 = options[i + 1];
      const isSelected2 = selectedItems.has(option2);
      row.push({
        text: `${isSelected2 ? '✅' : '◻️'} ${String(option2).slice(0, 25)}`,
        callback_data: `${callbackPrefix}${Buffer.from(String(option2)).toString('base64')}`
      });
    }
    keyboard.push(row);
  }
  const controlRow = [];
  if (selectedItems.size > 0 || callbackPrefix.includes('flag')) { 
      controlRow.push({ text: '✅ Применить', callback_data: 'apply_selection' });
  }
  if (backButton) {
    controlRow.push({ text: '◀️ Назад', callback_data: 'back' });
  }
  if (controlRow.length > 0) {
    keyboard.push(controlRow);
  }
  return { inline_keyboard: keyboard };
}

// Парсинг CSV
async function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

// Парсинг Excel
function parseExcel(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(worksheet);
}

// Создание CSV файла
async function createCSVFile(data, filename) {
  if (!data || data.length === 0) return null;
  // Убедимся, что все ключи есть во всех объектах для корректных заголовков
  const allKeys = new Set();
  data.forEach(row => Object.keys(row).forEach(key => allKeys.add(key)));
  const headers = Array.from(allKeys).map(key => ({ id: key, title: key }));

  const csvWriterInstance = createCsvWriter({
    path: filename,
    header: headers,
    encoding: 'utf8', 
    withBOM: true     // <--- ВОТ ОНО, ИСПРАВЛЕНИЕ ДЛЯ EXCEL
  });
  await csvWriterInstance.writeRecords(data);
  return filename;
}

// Разделение данных на части по N строк
function splitDataIntoChunks(data, chunkSize = 2000) {
  const chunks = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(data.slice(i, i + chunkSize));
  }
  return chunks;
}

// Обработчик команды /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  initUserState(chatId);
  try {
    await bot.sendMessage(chatId, 
      '🤖 Привет! Я бот для обработки файлов розыска авто.\n\n' +
      '📁 Отправьте мне CSV или Excel файл, и я:\n' +
      '• Умно очищу адреса\n' +
      '• Извлеку номерные знаки в отдельный столбец "НОМЕРНОЙ ЗНАК"\n' +
      '• Оставлю только Москву, Подмосковье и близлежащие города\n' +
      '• Предложу фильтры по типам адресов и флагам нового авто (если есть)\n' +
      '• Разделю итоговые файлы на части по 2000 строк\n\n' +
      'Просто отправьте файл!'
    );
  } catch (error) {
    console.error('Error sending start message:', error);
  }
});

// Обработчик загрузки документов
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const userState = initUserState(chatId);
  
  try {
    await bot.sendMessage(chatId, '⏳ Загружаю и обрабатываю файл...');
    
    const fileId = msg.document.file_id;
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    
    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();
    
    const tempPath = path.join('uploads', `${chatId}_${Date.now()}_${msg.document.file_name}`);
    fs.writeFileSync(tempPath, Buffer.from(buffer));
    
    let rawData;
    const fileName = msg.document.file_name.toLowerCase();
    
    if (fileName.endsWith('.csv')) {
      rawData = await parseCSV(tempPath);
    } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
      rawData = parseExcel(tempPath);
    } else {
      await bot.sendMessage(chatId, '❌ Поддерживаются только CSV и Excel файлы (.csv, .xlsx, .xls)');
      fs.unlinkSync(tempPath);
      return;
    }

    if (!rawData || rawData.length === 0) {
      await bot.sendMessage(chatId, '❌ Файл пустой или не удалось прочитать данные.');
      fs.unlinkSync(tempPath);
      return;
    }

    await bot.sendMessage(chatId, '🔧 Применяю умную очистку адресов и извлекаю номерные знаки...');
    let processedData = processRawData(rawData); 
    
    await bot.sendMessage(chatId, '🗺️ Фильтрую по Москве, Подмосковью и близлежащим городам...');
    let moscowData = filterMoscowRegions(processedData); 
    
    if (moscowData.length === 0) {
      await bot.sendMessage(chatId, '❌ После обработки и фильтрации по регионам данных не осталось.');
      fs.unlinkSync(tempPath);
      return;
    }
    
    userState.originalData = moscowData; 
    userState.addressTypes = getUniqueValues(moscowData, 'Тип адреса');
    userState.newCarFlags = getUniqueValues(moscowData, 'Флаг нового авто');
    
    await bot.sendMessage(chatId, 
      `✅ Первичная обработка завершена!\n\n` +
      `📊 Исходных записей в файле: ${rawData.length}\n` +
      `🔧 Записей после умной очистки: ${processedData.length}\n` +
      `🗺️ Записей по Москве/МО: ${moscowData.length}\n` +
      (userState.addressTypes.length > 0 ? `📋 Уникальных типов адресов: ${userState.addressTypes.length}\n` : '') +
      (userState.newCarFlags.length > 0 ? `🚗 Уникальных флагов авто: ${userState.newCarFlags.length}\n` : '') +
      `\nТеперь выберите, как выгрузить файлы:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➡️ Без доп. фильтров', callback_data: 'no_filters' }],
            [{ text: '⚙️ Применить фильтры', callback_data: 'with_filters' }]
          ]
        }
      }
    );
    
    userState.state = STATES.CHOOSE_FILTERS;
    fs.unlinkSync(tempPath);
    
  } catch (error) {
    console.error('Error processing file:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при обработке файла. Попробуйте еще раз или проверьте формат файла.');
  }
});

// Обработчик callback запросов
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const userState = userStates.get(chatId);
  
  if (!userState || !userState.originalData) { 
    await bot.answerCallbackQuery(query.id, { text: 'Сессия истекла или нет данных. Отправьте файл заново (/start).' });
    if(query.message) await bot.deleteMessage(chatId, query.message.message_id).catch(console.error);
    return;
  }
  
  try {
    await bot.answerCallbackQuery(query.id); 

    if (data === 'no_filters') {
      if(query.message) await bot.deleteMessage(chatId, query.message.message_id).catch(console.error);
      await handleNoFilters(chatId, userState);
    } else if (data === 'with_filters') {
      if(query.message) await bot.deleteMessage(chatId, query.message.message_id).catch(console.error);
      await handleWithFilters(chatId, userState);
    } else if (data === 'back') {
      if(query.message) await bot.deleteMessage(chatId, query.message.message_id).catch(console.error);
      await handleBack(chatId, userState);
    } else if (data.startsWith('toggle_address_')) {
      const option = Buffer.from(data.replace('toggle_address_', ''), 'base64').toString();
      await handleToggleAddress(chatId, userState, option, query);
    } else if (data.startsWith('toggle_flag_')) {
      const option = Buffer.from(data.replace('toggle_flag_', ''), 'base64').toString();
      await handleToggleFlag(chatId, userState, option, query);
    } else if (data === 'apply_selection') {
      if(query.message) await bot.deleteMessage(chatId, query.message.message_id).catch(console.error);
      await handleApplySelection(chatId, userState);
    } else if (data === 'reselect_filters') {
      if(query.message) await bot.deleteMessage(chatId, query.message.message_id).catch(console.error);
      userState.selectedAddressTypes.clear();
      userState.selectedNewCarFlags.clear();
      await handleWithFilters(chatId, userState);
    } else if (data === 'restart') {
      if(query.message) await bot.deleteMessage(chatId, query.message.message_id).catch(console.error);
      cleanupUserFiles(chatId);
      userStates.delete(chatId);
      initUserState(chatId);
      await bot.sendMessage(chatId, '🆕 Отправьте новый файл для обработки.');
    }
    
  } catch (error) {
    console.error('Error handling callback:', error);
  }
});

// Выгрузка без доп. фильтров
async function handleNoFilters(chatId, userState) {
  try {
    await bot.sendMessage(chatId, '📦 Готовлю файлы без дополнительных фильтров (только умная очистка, номера и регионы)...');
    
    const chunks = splitDataIntoChunks(userState.originalData); 
    const createdFiles = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const filename = `uploads/NO_FILTER_part_${i + 1}_${chatId}_${Date.now()}.csv`;
      await createCSVFile(chunks[i], filename);
      createdFiles.push({filename, count: chunks[i].length, part: i + 1});
    }
    
    for (const file of createdFiles) {
      await bot.sendDocument(chatId, file.filename, {
        caption: `📁 Часть ${file.part} (без доп. фильтров)\n📊 Записей: ${file.count}`
      });
    }
    
    if (!userFiles.has(chatId)) userFiles.set(chatId, []);
    userFiles.get(chatId).push(...createdFiles.map(f => f.filename));
    
    await bot.sendMessage(chatId, 
      `✅ Готово! Отправлено файлов: ${createdFiles.length}\n\n💡 Файлы готовы для загрузки в Google My Maps.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚙️ Попробовать с фильтрами', callback_data: 'with_filters' }],
            [{ text: '🆕 Загрузить новый файл', callback_data: 'restart' }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Error creating files (no_filters):', error);
    await bot.sendMessage(chatId, '❌ Ошибка при создании файлов.');
  }
}

// Начало выбора фильтров
async function handleWithFilters(chatId, userState) {
  userState.state = STATES.SELECT_ADDRESS_TYPE; 
  if (userState.addressTypes.length > 0) {
    const keyboard = createSelectionKeyboard(userState.addressTypes, userState.selectedAddressTypes, 'toggle_address_', true);
    await bot.sendMessage(chatId, 
      '🏠 Шаг 1: Выберите типы адресов (можно несколько):\n\n📌 Нажимайте на кнопки, чтобы выбрать/снять галочку. Затем "Применить".',
      { reply_markup: keyboard }
    );
  } else {
    await bot.sendMessage(chatId, 'ℹ️ Уникальных типов адресов для фильтрации не найдено.');
    await proceedToNewCarFlags(chatId, userState);
  }
}

async function proceedToNewCarFlags(chatId, userState) {
  userState.state = STATES.SELECT_NEW_CAR_FLAG;
  if (userState.newCarFlags.length > 0) {
    const keyboard = createSelectionKeyboard(userState.newCarFlags, userState.selectedNewCarFlags, 'toggle_flag_', true);
    await bot.sendMessage(chatId, 
      '🚗 Шаг 2: Выберите флаги нового авто (можно несколько):\n\n📌 Если не хотите фильтровать по этому критерию, просто нажмите "Применить".',
      { reply_markup: keyboard }
    );
  } else {
    await bot.sendMessage(chatId, 'ℹ️ Уникальных флагов нового авто для фильтрации не найдено.');
    await applyFiltersAndCreateFiles(chatId, userState); 
  }
}

// Обработка кнопки "Назад"
async function handleBack(chatId, userState) {
  if (userState.state === STATES.SELECT_ADDRESS_TYPE || userState.state === STATES.FILTERS_APPLIED) {
    userState.state = STATES.CHOOSE_FILTERS;
    userState.selectedAddressTypes.clear(); 
    userState.selectedNewCarFlags.clear();  
    await bot.sendMessage(chatId, 
      'Выберите, как выгрузить файлы:',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➡️ Без доп. фильтров', callback_data: 'no_filters' }],
            [{ text: '⚙️ Применить фильтры', callback_data: 'with_filters' }]
          ]
        }
      }
    );
  } else if (userState.state === STATES.SELECT_NEW_CAR_FLAG) {
    await handleWithFilters(chatId, userState);
  }
}

// Переключение опций для типов адресов
async function handleToggleAddress(chatId, userState, option, query) {
  if (userState.selectedAddressTypes.has(option)) {
    userState.selectedAddressTypes.delete(option);
  } else {
    userState.selectedAddressTypes.add(option);
  }
  const keyboard = createSelectionKeyboard(userState.addressTypes, userState.selectedAddressTypes, 'toggle_address_', true);
  try {
    await bot.editMessageReplyMarkup(keyboard, { chat_id: chatId, message_id: query.message.message_id });
  } catch (error) { if (error.response && error.response.statusCode !== 400) console.error('Error editing message (address):', error); }
}

// Переключение опций для флагов авто
async function handleToggleFlag(chatId, userState, option, query) {
  if (userState.selectedNewCarFlags.has(option)) {
    userState.selectedNewCarFlags.delete(option);
  } else {
    userState.selectedNewCarFlags.add(option);
  }
  const keyboard = createSelectionKeyboard(userState.newCarFlags, userState.selectedNewCarFlags, 'toggle_flag_', true);
  try {
    await bot.editMessageReplyMarkup(keyboard, { chat_id: chatId, message_id: query.message.message_id });
  } catch (error) { if (error.response && error.response.statusCode !== 400) console.error('Error editing message (flag):', error); }
}

// Применение выбора (после выбора типов адресов или флагов)
async function handleApplySelection(chatId, userState) {
  if (userState.state === STATES.SELECT_ADDRESS_TYPE) {
    if (userState.addressTypes.length > 0 && userState.selectedAddressTypes.size === 0) {
        // Информируем, но не блокируем переход, т.к. отсутствие выбора может означать "все"
        // await bot.sendMessage(chatId, "⚠️ Вы не выбрали ни одного типа адреса. Будут использованы все типы.");
    }
    await proceedToNewCarFlags(chatId, userState);
  } else if (userState.state === STATES.SELECT_NEW_CAR_FLAG) {
    await applyFiltersAndCreateFiles(chatId, userState);
  }
}

// Применение фильтров и создание файлов
async function applyFiltersAndCreateFiles(chatId, userState) {
  try {
    await bot.sendMessage(chatId, '⏳ Применяю выбранные фильтры и готовлю файлы...');
    
    let dataToFilter = [...userState.originalData]; 
    
    if (userState.selectedAddressTypes.size > 0) {
      dataToFilter = dataToFilter.filter(row => {
        const addressType = String(row['Тип адреса'] || row['тип адреса'] || row['ТИП АДРЕСА'] || '');
        return userState.selectedAddressTypes.has(addressType);
      });
    }

    if (userState.selectedNewCarFlags.size > 0) {
      dataToFilter = dataToFilter.filter(row => {
        const carFlag = String(row['Флаг нового авто'] || row['флаг нового авто'] || row['ФЛАГ НОВОГО АВТО'] || '');
        return userState.selectedNewCarFlags.has(carFlag);
      });
    }

    if (dataToFilter.length === 0) {
      await bot.sendMessage(chatId, '❌ По выбранным фильтрам данных не найдено.');
      await bot.sendMessage(chatId, "Попробуйте изменить выбор:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Перевыбрать фильтры', callback_data: 'reselect_filters' }],
            [{ text: '🆕 Загрузить новый файл', callback_data: 'restart' }]
          ]
        }
      });
      return;
    }
    
    const chunks = splitDataIntoChunks(dataToFilter);
    const createdFiles = [];

    for (let i = 0; i < chunks.length; i++) {
      const filename = `uploads/FILTERED_part_${i + 1}_${chatId}_${Date.now()}.csv`;
      await createCSVFile(chunks[i], filename);
      createdFiles.push({filename, count: chunks[i].length, part: i + 1});
    }
    
    for (const file of createdFiles) {
      await bot.sendDocument(chatId, file.filename, {
        caption: `📁 Часть ${file.part} (с фильтрами)\n📊 Записей: ${file.count}`
      });
    }
    
    if (!userFiles.has(chatId)) userFiles.set(chatId, []);
    userFiles.get(chatId).push(...createdFiles.map(f => f.filename));
    
    let filterSummary = `Фильтры применены:\n`;
    filterSummary += `🏠 Типы адресов: ${userState.selectedAddressTypes.size > 0 ? Array.from(userState.selectedAddressTypes).join(', ') : 'Все'}\n`;
    filterSummary += `🚗 Флаги авто: ${userState.selectedNewCarFlags.size > 0 ? Array.from(userState.selectedNewCarFlags).join(', ') : 'Все'}\n`;

    await bot.sendMessage(chatId, 
      `✅ Готово! Отправлено файлов: ${createdFiles.length}\n\n${filterSummary}\n💡 Файлы готовы для загрузки в Google My Maps.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Перевыбрать фильтры', callback_data: 'reselect_filters' }],
            [{ text: '🆕 Загрузить новый файл', callback_data: 'restart' }]
          ]
        }
      }
    );
    userState.state = STATES.FILTERS_APPLIED;
  } catch (error) {
    console.error('Error creating filtered files:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при создании файлов с фильтрами.');
  }
}

// ====== EXPRESS ENDPOINTS ======
app.get('/', (req, res) => res.send('Bot is running!'));

app.get('/registerWebhook', async (req, res) => {
  try {
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const webhookUrl = `${protocol}://${host}/webhook`;
    
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const result = await response.json();
    res.json({ success: result.ok, webhook_url: webhookUrl, telegram_response: result, message: result.ok ? 'Webhook успешно установлен!' : `Ошибка: ${result.description}` });
  } catch (error) {
    console.error('Error setting webhook via /registerWebhook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/webhook', async (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500); 
  }
});

async function setupWebhook() {
  try {
    if (WEBHOOK_URL) {
      let fullWebhookUrl = WEBHOOK_URL;
      if (!fullWebhookUrl.startsWith('https://')) {
          fullWebhookUrl = `https://${fullWebhookUrl.replace(/^http:\/\//i, '')}`;
      }
      if (!fullWebhookUrl.endsWith('/webhook')) {
          fullWebhookUrl = `${fullWebhookUrl.replace(/\/$/, '')}/webhook`;
      }
        
      await bot.setWebHook(fullWebhookUrl);
      console.log('Webhook set successfully to:', fullWebhookUrl);
    } else {
      console.log('WEBHOOK_URL environment variable not set. Starting in polling mode.');
      bot.startPolling({ polling: { autoStart: true, interval: 300 } }).catch(err => {
          console.error("Polling error:", err);
      });
    }
  } catch (error) {
    console.error('Error setting webhook during startup:', error);
    console.log('Failed to set webhook, attempting to start in polling mode.');
    bot.startPolling({ polling: { autoStart: true, interval: 300 } }).catch(err => {
        console.error("Polling error after webhook failure:", err);
    });
  }
}

process.on('SIGTERM', () => { userFiles.forEach((_files, chatId) => cleanupUserFiles(chatId)); process.exit(0); });
process.on('SIGINT', () => { userFiles.forEach((_files, chatId) => cleanupUserFiles(chatId)); process.exit(0); });

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setupWebhook(); 
});

