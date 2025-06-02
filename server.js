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

// Хранилище состояний пользователей
const userStates = new Map();

// Состояния диалога
const STATES = {
  WAITING_FILE: 'waiting_file',
  ASKING_FILTERS: 'asking_filters',
  SELECTING_ADDRESS_TYPES: 'selecting_address_types',
  SELECTING_CAR_TYPES: 'selecting_car_types',
  FILES_SENT: 'files_sent'
};

// Инициализация состояния пользователя
function initUserState(chatId) {
  userStates.set(chatId, {
    state: STATES.WAITING_FILE,
    csvContent: null,
    fileName: null,
    availableAddressTypes: [],
    availableCarTypes: [],
    selectedAddressTypes: new Set(),
    selectedCarTypes: new Set(),
    processedData: null
  });
}

// Получение состояния пользователя
function getUserState(chatId) {
  if (!userStates.has(chatId)) {
    initUserState(chatId);
  }
  return userStates.get(chatId);
}

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

// Конвертация Excel в CSV на сервере
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

// Получение уникальных значений из CSV
function getUniqueValues(csvContent, columnName) {
  try {
    const lines = csvContent.split('\n');
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const columnIndex = headers.findIndex(h => h.toLowerCase().includes(columnName.toLowerCase()));
    
    if (columnIndex === -1) return [];
    
    const uniqueValues = new Set();
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',');
      if (cells[columnIndex]) {
        const value = cells[columnIndex].trim().replace(/"/g, '');
        if (value) uniqueValues.add(value);
      }
    }
    
    return Array.from(uniqueValues).slice(0, 20); // Ограничиваем 20 значениями
  } catch (error) {
    console.error('Error getting unique values:', error);
    return [];
  }
}

// Отправка CSV на обработку в Apps Script
async function processCSVInAppsScript(csvContent, fileName, filters = null) {
  try {
    console.log(`Sending CSV to Apps Script: ${fileName}, length: ${csvContent.length}`);
    
    const base64Content = Buffer.from(csvContent, 'utf8').toString('base64');
    
    const requestData = {
      action: 'process_csv',
      csvContent: base64Content,
      fileName: fileName
    };
    
    if (filters) {
      requestData.filters = filters;
    }
    
    const response = await axios.post(APPS_SCRIPT_URL, requestData, {
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

// Создание кнопок для выбора фильтров
function createFilterKeyboard(options, selected, backButton = true) {
  const keyboard = [];
  
  // Создаем кнопки по 2 в ряду
  for (let i = 0; i < options.length; i += 2) {
    const row = [];
    
    const option1 = options[i];
    const isSelected1 = selected.has(option1);
    row.push({
      text: `${isSelected1 ? '✅' : '☐'} ${option1}`,
      callback_data: `toggle_${i}`
    });
    
    if (i + 1 < options.length) {
      const option2 = options[i + 1];
      const isSelected2 = selected.has(option2);
      row.push({
        text: `${isSelected2 ? '✅' : '☐'} ${option2}`,
        callback_data: `toggle_${i + 1}`
      });
    }
    
    keyboard.push(row);
  }
  
  // Кнопки управления
  const controlRow = [];
  if (backButton) {
    controlRow.push({ text: '◀️ Назад', callback_data: 'back' });
  }
  controlRow.push({ text: '➡️ Далее', callback_data: 'next' });
  
  if (controlRow.length > 0) {
    keyboard.push(controlRow);
  }
  
  return { inline_keyboard: keyboard };
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

// Обработчик команды /start
async function handleStart(chatId) {
  initUserState(chatId);
  
  const welcomeMessage = `
🚗 **Добро пожаловать в Rozysk Avto Bot v6.0!**

🆕 **Новые возможности:**
• Фильтрация по регионам (только Москва и область)
• Выбор типов адресов
• Фильтрация по возрасту авто
• Интерактивные фильтры с возможностью перевыбора

✅ **Основные функции:**
• Очистка адресов от лишней информации
• Извлечение номерных знаков
• Разделение на части по 2000 строк
• Геопривязка для карт

📎 **Поддерживаемые форматы:**
• CSV (.csv)
• Excel (.xlsx, .xls)

📤 **Отправьте файл для обработки!**
  `;
  
  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
}

// Обработчик документов
async function handleDocument(chatId, document) {
  const userState = getUserState(chatId);
  const fileName = document.file_name;
  const fileSize = document.file_size;

  console.log(`Processing document: ${fileName}, size: ${fileSize} bytes`);

  try {
    if (!isSupportedFile(fileName)) {
      await bot.sendMessage(chatId, '❌ Поддерживаются только файлы: CSV, Excel (.xlsx, .xls)');
      return;
    }

    const processingMsg = await bot.sendMessage(chatId, '⏳ Загружаю файл...');

    // Получаем файл
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

    // Сохраняем данные в состоянии
    userState.csvContent = csvContent;
    userState.fileName = fileName;

    // Получаем уникальные значения для фильтров
    await bot.editMessageText('📊 Анализирую данные...', {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });

    userState.availableAddressTypes = getUniqueValues(csvContent, 'тип адреса');
    userState.availableCarTypes = getUniqueValues(csvContent, 'флаг нового авто');

    await bot.deleteMessage(chatId, processingMsg.message_id);

    // Спрашиваем о фильтрах
    userState.state = STATES.ASKING_FILTERS;
    await askForFilters(chatId);

  } catch (error) {
    console.error('Error processing document:', error);
    await bot.sendMessage(chatId, `❌ ${error.message}`);
  }
}

// Спрашиваем о применении фильтров
async function askForFilters(chatId) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🎯 Применить фильтры', callback_data: 'apply_filters' },
        { text: '📁 Без фильтров', callback_data: 'no_filters' }
      ]
    ]
  };

  await bot.sendMessage(chatId, 
    '🤔 **Хотите применить фильтры к данным?**\n\n' +
    '🎯 **С фильтрами:** только Москва и область, выбор типов адресов и авто\n' +
    '📁 **Без фильтров:** все данные как есть', 
    { 
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }
  );
}

// Выбор типов адресов
async function selectAddressTypes(chatId) {
  const userState = getUserState(chatId);
  userState.state = STATES.SELECTING_ADDRESS_TYPES;

  if (userState.availableAddressTypes.length === 0) {
    await bot.sendMessage(chatId, '⚠️ В файле не найден столбец "тип адреса". Переходим к следующему шагу.');
    await selectCarTypes(chatId);
    return;
  }

  const keyboard = createFilterKeyboard(
    userState.availableAddressTypes, 
    userState.selectedAddressTypes,
    true
  );

  await bot.sendMessage(chatId,
    '🏠 **Выберите типы адресов для включения в результат:**\n\n' +
    'Нажмите на варианты для выбора/отмены выбора.',
    {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }
  );
}

// Выбор типов авто
async function selectCarTypes(chatId) {
  const userState = getUserState(chatId);
  userState.state = STATES.SELECTING_CAR_TYPES;

  if (userState.availableCarTypes.length === 0) {
    await bot.sendMessage(chatId, '⚠️ В файле не найден столбец с данными о возрасте авто. Обрабатываем с текущими фильтрами.');
    await processWithFilters(chatId);
    return;
  }

  const keyboard = createFilterKeyboard(
    userState.availableCarTypes, 
    userState.selectedCarTypes,
    true
  );

  await bot.sendMessage(chatId,
    '🚗 **Выберите типы авто (старое/новое):**\n\n' +
    'Нажмите на варианты для выбора/отмены выбора.',
    {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    }
  );
}

// Обработка с фильтрами
async function processWithFilters(chatId) {
  const userState = getUserState(chatId);
  
  const processingMsg = await bot.sendMessage(chatId, '🔄 Применяю фильтры и обрабатываю данные...');

  try {
    const filters = {
      regionFilter: true, // Всегда фильтруем по регионам
      addressTypes: Array.from(userState.selectedAddressTypes),
      carTypes: Array.from(userState.selectedCarTypes)
    };

    const result = await processCSVInAppsScript(userState.csvContent, userState.fileName, filters);

    if (result.success) {
      await bot.deleteMessage(chatId, processingMsg.message_id);
      await sendProcessedFiles(chatId, result, true);
    } else {
      await bot.editMessageText(`❌ Ошибка обработки: ${result.error}`, {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
    }

  } catch (error) {
    console.error('Error processing with filters:', error);
    await bot.editMessageText(`❌ ${error.message}`, {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });
  }
}

// Обработка без фильтров
async function processWithoutFilters(chatId) {
  const userState = getUserState(chatId);
  
  const processingMsg = await bot.sendMessage(chatId, '⚡ Обрабатываю данные без фильтров...');

  try {
    const result = await processCSVInAppsScript(userState.csvContent, userState.fileName);

    if (result.success) {
      await bot.deleteMessage(chatId, processingMsg.message_id);
      await sendProcessedFiles(chatId, result, false);
    } else {
      await bot.editMessageText(`❌ Ошибка обработки: ${result.error}`, {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
    }

  } catch (error) {
    console.error('Error processing without filters:', error);
    await bot.editMessageText(`❌ ${error.message}`, {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });
  }
}

// Отправка обработанных файлов
async function sendProcessedFiles(chatId, result, withFilters) {
  const userState = getUserState(chatId);
  userState.state = STATES.FILES_SENT;

  const filterInfo = withFilters ? 
    `\n🎯 **Применены фильтры:**\n` +
    `• Регион: Москва и область\n` +
    `• Типы адресов: ${userState.selectedAddressTypes.size > 0 ? Array.from(userState.selectedAddressTypes).join(', ') : 'все'}\n` +
    `• Типы авто: ${userState.selectedCarTypes.size > 0 ? Array.from(userState.selectedCarTypes).join(', ') : 'все'}` :
    '\n📁 **Обработано без фильтров**';

  const resultMessage = `
✅ **Файл успешно обработан!**

📊 **Статистика:**
• Всего строк: ${result.totalRows}
• Создано частей: ${result.partsCount}${filterInfo}

📁 **Отправляю файлы...**
  `;

  await bot.sendMessage(chatId, resultMessage, { parse_mode: 'Markdown' });

  // Инструкция
  const instructionMessage = `
💡 **Инструкция по использованию:**

1. Сохраните файлы на устройство
2. Перейдите в Google My Maps (mymaps.google.com)
3. Создайте новую карту
4. Загружайте каждый файл отдельно
5. Адреса автоматически станут точками на карте

🎯 **Каждый файл: до 2000 записей**
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

  // Кнопки для дальнейших действий
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Перевыбрать фильтры', callback_data: 'reselect_filters' },
        { text: '📎 Новый файл', callback_data: 'new_file' }
      ]
    ]
  };

  await bot.sendMessage(chatId, 
    '🎉 **Все файлы отправлены!**\n\nВыберите дальнейшее действие:', 
    { 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    }
  );
}

// Обработчик callback запросов
async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const userState = getUserState(chatId);

  try {
    await bot.answerCallbackQuery(callbackQuery.id);

    if (data === 'apply_filters') {
      await selectAddressTypes(chatId);
    }
    else if (data === 'no_filters') {
      await processWithoutFilters(chatId);
    }
    else if (data === 'back') {
      if (userState.state === STATES.SELECTING_ADDRESS_TYPES) {
        await askForFilters(chatId);
      } else if (userState.state === STATES.SELECTING_CAR_TYPES) {
        await selectAddressTypes(chatId);
      }
    }
    else if (data === 'next') {
      if (userState.state === STATES.SELECTING_ADDRESS_TYPES) {
        await selectCarTypes(chatId);
      } else if (userState.state === STATES.SELECTING_CAR_TYPES) {
        await processWithFilters(chatId);
      }
    }
    else if (data.startsWith('toggle_')) {
      const index = parseInt(data.split('_')[1]);
      
      if (userState.state === STATES.SELECTING_ADDRESS_TYPES) {
        const option = userState.availableAddressTypes[index];
        if (userState.selectedAddressTypes.has(option)) {
          userState.selectedAddressTypes.delete(option);
        } else {
          userState.selectedAddressTypes.add(option);
        }
        
        const keyboard = createFilterKeyboard(
          userState.availableAddressTypes, 
          userState.selectedAddressTypes,
          true
        );
        
        await bot.editMessageReplyMarkup(keyboard, {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id
        });
      }
      else if (userState.state === STATES.SELECTING_CAR_TYPES) {
        const option = userState.availableCarTypes[index];
        if (userState.selectedCarTypes.has(option)) {
          userState.selectedCarTypes.delete(option);
        } else {
          userState.selectedCarTypes.add(option);
        }
        
        const keyboard = createFilterKeyboard(
          userState.availableCarTypes, 
          userState.selectedCarTypes,
          true
        );
        
        await bot.editMessageReplyMarkup(keyboard, {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id
        });
      }
    }
    else if (data === 'reselect_filters') {
      // Сбрасываем выборы и начинаем заново
      userState.selectedAddressTypes.clear();
      userState.selectedCarTypes.clear();
      await askForFilters(chatId);
    }
    else if (data === 'new_file') {
      initUserState(chatId);
      await bot.sendMessage(chatId, '📎 Отправьте новый файл для обработки.');
    }

  } catch (error) {
    console.error('Error handling callback query:', error);
    await bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте еще раз.');
  }
}

// Обработчик текстовых сообщений
async function handleMessage(chatId, text) {
  if (text && !text.startsWith('/')) {
    await bot.sendMessage(chatId, '📎 Отправьте файл для обработки (CSV или Excel)');
  }
}

// Webhook endpoint
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  try {
    const update = req.body;
    
    if (update.message) {
      const chatId = update.message.chat.id;
      const message = update.message;

      console.log('Received message from chat:', chatId);

      if (message.text === '/start') {
        await handleStart(chatId);
      }
      else if (message.document) {
        await handleDocument(chatId, message.document);
      }
      else if (message.text) {
        await handleMessage(chatId, message.text);
      }
    }
    else if (update.callback_query) {
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
      <title>Rozysk Avto Bot v6.0</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 50px; text-align: center; background: #f0f0f0; }
        .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .status { color: #4CAF50; font-size: 24px; font-weight: bold; }
        .info { color: #666; margin-top: 20px; line-height: 1.6; }
        .version { background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0; }
        .features { background: #f3e5f5; padding: 15px; border-radius: 5px; margin: 10px 0; text-align: left; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚗 Rozysk Avto Bot</h1>
        <div class="status">✅ Сервис работает!</div>
        <div class="version">
          <strong>Версия 6.0 - ИНТЕРАКТИВНЫЕ ФИЛЬТРЫ</strong><br>
          • Полная фильтрация данных<br>
          • Интерактивный выбор параметров<br>
          • Возможность перевыбора фильтров
        </div>
        <div class="features">
          <strong>🎯 Новые возможности:</strong><br>
          • Фильтрация по регионам (Москва + область)<br>
          • Выбор типов адресов<br>
          • Фильтрация по возрасту авто<br>
          • Кнопки "Назад" и "Перевыбрать"<br>
          • Интерактивные checkbox'ы
        </div>
        <div class="info">
          <p><strong>Telegram:</strong> <a href="https://t.me/rozysk_avto_bot">@rozysk_avto_bot</a></p>
          <p><strong>Поддержка:</strong> CSV, Excel (xlsx, xls)</p>
          <p><strong>Статус:</strong> ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get('/doget', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Rozysk Avto Bot v6.0 - Interactive Filters',
    webhook: WEBHOOK_URL,
    timestamp: new Date().toISOString(),
    features: [
      'Regional filtering (Moscow + region)',
      'Interactive address type selection',
      'Car type filtering',
      'Filter reselection capability',
      'Back navigation buttons'
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
  console.log(`🚀 Server v6.0 running on port ${port}`);
  console.log(`📡 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`🎯 Features: Interactive Filters + Regional Filtering`);
  
  await setupWebhook();
  
  console.log('✅ Telegram bot v6.0 with Interactive Filters is ready!');
});
