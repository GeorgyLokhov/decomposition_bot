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

// Настройка multer для загрузки файлов
const upload = multer({ dest: 'uploads/' });

// Московские регионы и близлежащие области
const MOSCOW_REGIONS = [
  'москва', 'московская область', 'подмосковье', 'калужская область',
  'тульская область', 'рязанская область', 'владимирская область',
  'смоленская область', 'тверская область', 'ярославская область'
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

// Фильтрация по московским регионам
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

// Получение уникальных значений из столбца
function getUniqueValues(data, columnName) {
  const possibleColumns = [columnName, columnName.toLowerCase(), columnName.toUpperCase()];
  
  for (const col of possibleColumns) {
    if (data.length > 0 && data[0].hasOwnProperty(col)) {
      return [...new Set(data.map(row => row[col]).filter(val => val !== undefined && val !== null && val !== ''))];
    }
  }
  return [];
}

// Создание inline клавиатуры для выбора
function createSelectionKeyboard(options, selectedItems, backButton = true) {
  const keyboard = [];
  
  // Добавляем опции по 2 в ряд
  for (let i = 0; i < options.length; i += 2) {
    const row = [];
    
    const option1 = options[i];
    const isSelected1 = selectedItems.has(option1);
    row.push({
      text: `${isSelected1 ? '✅' : '◻️'} ${option1}`,
      callback_data: `toggle_${Buffer.from(option1).toString('base64')}`
    });
    
    if (i + 1 < options.length) {
      const option2 = options[i + 1];
      const isSelected2 = selectedItems.has(option2);
      row.push({
        text: `${isSelected2 ? '✅' : '◻️'} ${option2}`,
        callback_data: `toggle_${Buffer.from(option2).toString('base64')}`
      });
    }
    
    keyboard.push(row);
  }
  
  // Кнопки управления
  const controlRow = [];
  if (selectedItems.size > 0) {
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

// Обработка CSV файлов
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

// Обработка Excel файлов
function parseExcel(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(worksheet);
}

// Создание CSV файла
async function createCSVFile(data, filename) {
  if (data.length === 0) return null;
  
  const headers = Object.keys(data[0]).map(key => ({ id: key, title: key }));
  const csvWriter = createCsvWriter({
    path: filename,
    header: headers,
    encoding: 'utf8'
  });
  
  await csvWriter.writeRecords(data);
  return filename;
}

// Разделение данных по типам адресов
function splitDataByAddressTypes(data, selectedTypes) {
  const result = {};
  
  selectedTypes.forEach(type => {
    result[type] = data.filter(row => {
      const addressType = row['Тип адреса'] || row['тип адреса'] || row['ТИП АДРЕСА'] || '';
      return addressType === type;
    });
  });
  
  return result;
}

// Обработчик команды /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  initUserState(chatId);
  
  try {
    await bot.sendMessage(chatId, 
      '🤖 Привет! Я бот для обработки файлов.\n\n' +
      '📁 Отправьте мне CSV или Excel файл, и я обработаю его:\n' +
      '• Оставлю только данные по Москве и Подмосковью\n' +
      '• Предложу настроить фильтры\n' +
      '• Разделю файл по выбранным критериям'
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
    
    // Скачиваем файл
    const fileId = msg.document.file_id;
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    
    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();
    
    const tempPath = path.join('uploads', `${chatId}_${Date.now()}_${msg.document.file_name}`);
    fs.writeFileSync(tempPath, Buffer.from(buffer));
    
    // Парсим файл
    let data;
    const fileName = msg.document.file_name.toLowerCase();
    
    if (fileName.endsWith('.csv')) {
      data = await parseCSV(tempPath);
    } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
      data = parseExcel(tempPath);
    } else {
      await bot.sendMessage(chatId, '❌ Поддерживаются только CSV и Excel файлы');
      fs.unlinkSync(tempPath);
      return;
    }
    
    // Фильтруем по московским регионам
    const moscowData = filterMoscowRegions(data);
    
    if (moscowData.length === 0) {
      await bot.sendMessage(chatId, '❌ В файле не найдено данных по Москве и Подмосковью');
      fs.unlinkSync(tempPath);
      return;
    }
    
    // Сохраняем данные в состояние пользователя
    userState.originalData = moscowData;
    userState.addressTypes = getUniqueValues(moscowData, 'Тип адреса');
    userState.newCarFlags = getUniqueValues(moscowData, 'Флаг нового авто');
    
    await bot.sendMessage(chatId, 
      `✅ Файл обработан!\n\n` +
      `📊 Найдено записей по Москве/Подмосковью: ${moscowData.length}\n` +
      `📋 Уникальных типов адресов: ${userState.addressTypes.length}\n` +
      `🚗 Уникальных флагов авто: ${userState.newCarFlags.length}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Без фильтров', callback_data: 'no_filters' },
              { text: '🎯 С фильтрами', callback_data: 'with_filters' }
            ]
          ]
        }
      }
    );
    
    userState.state = STATES.CHOOSE_FILTERS;
    fs.unlinkSync(tempPath);
    
  } catch (error) {
    console.error('Error processing file:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при обработке файла. Попробуйте еще раз.');
  }
});

// Обработчик callback запросов
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const userState = userStates.get(chatId);
  
  if (!userState) {
    await bot.answerCallbackQuery(query.id, { text: 'Сессия истекла. Начните заново с /start' });
    return;
  }
  
  try {
    if (data === 'no_filters') {
      await handleNoFilters(chatId, userState);
      
    } else if (data === 'with_filters') {
      await handleWithFilters(chatId, userState);
      
    } else if (data === 'back') {
      await handleBack(chatId, userState);
      
    } else if (data.startsWith('toggle_')) {
      const option = Buffer.from(data.replace('toggle_', ''), 'base64').toString();
      await handleToggle(chatId, userState, option, query);
      
    } else if (data === 'apply_selection') {
      await handleApplySelection(chatId, userState);
      
    } else if (data === 'reselect_filters') {
      userState.selectedAddressTypes.clear();
      userState.selectedNewCarFlags.clear();
      await handleWithFilters(chatId, userState);
      
    } else if (data === 'restart') {
      cleanupUserFiles(chatId);
      userStates.delete(chatId);
      initUserState(chatId);
      await bot.sendMessage(chatId, 'Отправьте новый файл для обработки');
    }
    
    await bot.answerCallbackQuery(query.id);
    
  } catch (error) {
    console.error('Error handling callback:', error);
    await bot.answerCallbackQuery(query.id, { text: 'Произошла ошибка' });
  }
});

// Обработка без фильтров
async function handleNoFilters(chatId, userState) {
  try {
    const filename = `uploads/processed_${chatId}_${Date.now()}.csv`;
    await createCSVFile(userState.originalData, filename);
    
    await bot.sendDocument(chatId, filename, {
      caption: `📁 Обработанный файл без фильтров\n📊 Записей: ${userState.originalData.length}`
    });
    
    if (!userFiles.has(chatId)) {
      userFiles.set(chatId, []);
    }
    userFiles.get(chatId).push(filename);
    
    await bot.sendMessage(chatId, 
      'Хотите также получить файлы с фильтрами?',
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🎯 Да, с фильтрами', callback_data: 'with_filters' },
              { text: '🆕 Новый файл', callback_data: 'restart' }
            ]
          ]
        }
      }
    );
    
  } catch (error) {
    console.error('Error creating file without filters:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при создании файла');
  }
}

// Обработка с фильтрами
async function handleWithFilters(chatId, userState) {
  userState.state = STATES.SELECT_ADDRESS_TYPE;
  
  const keyboard = createSelectionKeyboard(
    userState.addressTypes, 
    userState.selectedAddressTypes,
    true
  );
  
  await bot.sendMessage(chatId, 
    '🏠 Выберите типы адресов:\n\n' +
    `Доступно вариантов: ${userState.addressTypes.length}`,
    { reply_markup: keyboard }
  );
}

// Обработка кнопки "Назад"
async function handleBack(chatId, userState) {
  if (userState.state === STATES.SELECT_ADDRESS_TYPE) {
    userState.state = STATES.CHOOSE_FILTERS;
    await bot.sendMessage(chatId, 
      'Выберите вариант обработки:',
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Без фильтров', callback_data: 'no_filters' },
              { text: '🎯 С фильтрами', callback_data: 'with_filters' }
            ]
          ]
        }
      }
    );
  } else if (userState.state === STATES.SELECT_NEW_CAR_FLAG) {
    await handleWithFilters(chatId, userState);
  }
}

// Обработка переключения опций
async function handleToggle(chatId, userState, option, query) {
  if (userState.state === STATES.SELECT_ADDRESS_TYPE) {
    if (userState.selectedAddressTypes.has(option)) {
      userState.selectedAddressTypes.delete(option);
    } else {
      userState.selectedAddressTypes.add(option);
    }
    
    const keyboard = createSelectionKeyboard(
      userState.addressTypes, 
      userState.selectedAddressTypes,
      true
    );
    
    try {
      await bot.editMessageReplyMarkup(keyboard, {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    } catch (error) {
      console.error('Error editing message:', error);
    }
    
  } else if (userState.state === STATES.SELECT_NEW_CAR_FLAG) {
    if (userState.selectedNewCarFlags.has(option)) {
      userState.selectedNewCarFlags.delete(option);
    } else {
      userState.selectedNewCarFlags.add(option);
    }
    
    const keyboard = createSelectionKeyboard(
      userState.newCarFlags, 
      userState.selectedNewCarFlags,
      true
    );
    
    try {
      await bot.editMessageReplyMarkup(keyboard, {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    } catch (error) {
      console.error('Error editing message:', error);
    }
  }
}

// Применение выбора
async function handleApplySelection(chatId, userState) {
  if (userState.state === STATES.SELECT_ADDRESS_TYPE && userState.selectedAddressTypes.size > 0) {
    userState.state = STATES.SELECT_NEW_CAR_FLAG;
    
    const keyboard = createSelectionKeyboard(
      userState.newCarFlags, 
      userState.selectedNewCarFlags,
      true
    );
    
    await bot.sendMessage(chatId, 
      '🚗 Выберите флаги нового авто:\n\n' +
      `Доступно вариантов: ${userState.newCarFlags.length}`,
      { reply_markup: keyboard }
    );
    
  } else if (userState.state === STATES.SELECT_NEW_CAR_FLAG && userState.selectedNewCarFlags.size > 0) {
    await applyFiltersAndCreateFiles(chatId, userState);
  }
}

// Применение фильтров и создание файлов
async function applyFiltersAndCreateFiles(chatId, userState) {
  try {
    await bot.sendMessage(chatId, '⏳ Создаю файлы с выбранными фильтрами...');
    
    let filteredData = [...userState.originalData];
    
    if (userState.selectedAddressTypes.size > 0) {
      filteredData = filteredData.filter(row => {
        const addressType = row['Тип адреса'] || row['тип адреса'] || row['ТИП АДРЕСА'] || '';
        return userState.selectedAddressTypes.has(addressType);
      });
    }
    
    if (userState.selectedNewCarFlags.size > 0) {
      filteredData = filteredData.filter(row => {
        const carFlag = row['Флаг нового авто'] || row['флаг нового авто'] || row['ФЛАГ НОВОГО АВТО'] || '';
        return userState.selectedNewCarFlags.has(carFlag);
      });
    }
    
    if (filteredData.length === 0) {
      await bot.sendMessage(chatId, '❌ По выбранным фильтрам данных не найдено');
      return;
    }
    
    const splitData = splitDataByAddressTypes(filteredData, userState.selectedAddressTypes);
    const createdFiles = [];
    
    for (const [addressType, data] of Object.entries(splitData)) {
      if (data.length > 0) {
        const safeName = addressType.replace(/[^a-zA-Zа-яА-Я0-9]/g, '_');
        const filename = `uploads/${safeName}_${chatId}_${Date.now()}.csv`;
        await createCSVFile(data, filename);
        createdFiles.push({ filename, addressType, count: data.length });
      }
    }
    
    for (const file of createdFiles) {
      await bot.sendDocument(chatId, file.filename, {
        caption: `📁 ${file.addressType}\n📊 Записей: ${file.count}`
      });
    }
    
    if (!userFiles.has(chatId)) {
      userFiles.set(chatId, []);
    }
    userFiles.get(chatId).push(...createdFiles.map(f => f.filename));
    
    await bot.sendMessage(chatId, 
      `✅ Готово! Создано файлов: ${createdFiles.length}\n\n` +
      `Выбранные фильтры:\n` +
      `🏠 Типы адресов: ${Array.from(userState.selectedAddressTypes).join(', ')}\n` +
      `🚗 Флаги авто: ${Array.from(userState.selectedNewCarFlags).join(', ')}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Перевыбрать фильтры', callback_data: 'reselect_filters' },
              { text: '🆕 Новый файл', callback_data: 'restart' }
            ]
          ]
        }
      }
    );
    
    userState.state = STATES.FILTERS_APPLIED;
    
  } catch (error) {
    console.error('Error creating filtered files:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при создании файлов с фильтрами');
  }
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Bot is running!');
});

// Установка webhook при запуске
async function setWebhook() {
  try {
    if (WEBHOOK_URL) {
      await bot.setWebHook(`${WEBHOOK_URL}/webhook`);
      console.log('Webhook set successfully');
    } else {
      console.log('WEBHOOK_URL not set, using polling');
      bot.startPolling();
    }
  } catch (error) {
    console.error('Error setting webhook:', error);
  }
}

// Очистка файлов при завершении
process.on('SIGTERM', () => {
  userFiles.forEach((files, chatId) => {
    cleanupUserFiles(chatId);
  });
});

process.on('SIGINT', () => {
  userFiles.forEach((files, chatId) => {
    cleanupUserFiles(chatId);
  });
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setWebhook();
});
