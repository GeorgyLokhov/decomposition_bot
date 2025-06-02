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

// Хранилище состояний пользователей
const userStates = new Map();
const userFileData = new Map();

// Состояния пользователя
const STATES = {
  IDLE: 'idle',
  WAITING_FILTER_CHOICE: 'waiting_filter_choice',
  SELECTING_ADDRESS_TYPE: 'selecting_address_type',
  SELECTING_CAR_TYPE: 'selecting_car_type',
  READY_TO_PROCESS: 'ready_to_process'
};

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Устанавливаем webhook
async function setupWebhook() {
  try {
    await bot.setWebHook(WEBHOOK_URL);
    console.log('✅ Webhook установлен:', WEBHOOK_URL);
  } catch (error) {
    console.error('❌ Ошибка установки webhook:', error);
  }
}

// Инициализация состояния пользователя
function initUserState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      state: STATES.IDLE,
      selectedAddressTypes: new Set(),
      selectedCarTypes: new Set(),
      availableAddressTypes: [],
      availableCarTypes: [],
      fileName: '',
      csvContent: ''
    });
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

// Получаем уникальные значения из CSV для фильтров
function getUniqueValues(csvContent) {
  try {
    const lines = csvContent.split('\n');
    if (lines.length < 2) return { addressTypes: [], carTypes: [] };
    
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    
    // Ищем индексы нужных колонок
    const addressTypeIndex = headers.findIndex(h => 
      h.toLowerCase().includes('тип адреса') || h.toLowerCase().includes('address')
    );
    const carTypeIndex = headers.findIndex(h => 
      h.toLowerCase().includes('флаг') || h.toLowerCase().includes('авто')
    );
    
    const addressTypes = new Set();
    const carTypes = new Set();
    
    // Парсим данные
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      
      const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
      
      if (addressTypeIndex !== -1 && values[addressTypeIndex]) {
        addressTypes.add(values[addressTypeIndex]);
      }
      
      if (carTypeIndex !== -1 && values[carTypeIndex]) {
        carTypes.add(values[carTypeIndex]);
      }
    }
    
    return {
      addressTypes: Array.from(addressTypes).filter(Boolean),
      carTypes: Array.from(carTypes).filter(Boolean)
    };
    
  } catch (error) {
    console.error('Error parsing CSV for unique values:', error);
    return { addressTypes: [], carTypes: [] };
  }
}

// Отправляем CSV на обработку в Apps Script
async function processCSVInAppsScript(csvContent, fileName, filters = null) {
  try {
    console.log(`Sending CSV to Apps Script: ${fileName}, length: ${csvContent.length}`);
    
    const base64Content = Buffer.from(csvContent, 'utf8').toString('base64');
    
    const requestData = {
      action: 'process_csv',
      csvContent: base64Content,
      fileName: fileName
    };
    
    // Добавляем фильтры если они есть
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

// Создаем клавиатуру для выбора фильтров
function createFilterKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Да, нужны фильтры', callback_data: 'filter_yes' }],
        [{ text: '❌ Нет, без фильтров', callback_data: 'filter_no' }]
      ]
    }
  };
}

// Создаем клавиатуру для выбора типов адресов
function createAddressTypeKeyboard(availableTypes, selectedTypes) {
  const keyboard = [];
  
  // Группируем по 2 кнопки в ряд
  for (let i = 0; i < availableTypes.length; i += 2) {
    const row = [];
    
    for (let j = i; j < Math.min(i + 2, availableTypes.length); j++) {
      const type = availableTypes[j];
      const isSelected = selectedTypes.has(type);
      const text = isSelected ? `✅ ${type}` : `⬜ ${type}`;
      
      row.push({
        text: text,
        callback_data: `addr_${j}`
      });
    }
    
    keyboard.push(row);
  }
  
  // Кнопки управления
  keyboard.push([
    { text: '➡️ Далее к выбору авто', callback_data: 'addr_next' },
    { text: '🔙 Назад', callback_data: 'addr_back' }
  ]);
  
  return { reply_markup: { inline_keyboard: keyboard } };
}

// Создаем клавиатуру для выбора типов авто
function createCarTypeKeyboard(availableTypes, selectedTypes) {
  const keyboard = [];
  
  // Группируем по 2 кнопки в ряд
  for (let i = 0; i < availableTypes.length; i += 2) {
    const row = [];
    
    for (let j = i; j < Math.min(i + 2, availableTypes.length); j++) {
      const type = availableTypes[j];
      const isSelected = selectedTypes.has(type);
      const text = isSelected ? `✅ ${type}` : `⬜ ${type}`;
      
      row.push({
        text: text,
        callback_data: `car_${j}`
      });
    }
    
    keyboard.push(row);
  }
  
  // Кнопки управления
  keyboard.push([
    { text: '🎯 Применить фильтры', callback_data: 'car_apply' },
    { text: '🔙 Назад к типам адресов', callback_data: 'car_back' }
  ]);
  
  return { reply_markup: { inline_keyboard: keyboard } };
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
  userStates.get(chatId).state = STATES.IDLE;
  
  const welcomeMessage = `
🚗 **Добро пожаловать в Rozysk Avto Bot v6.0!**

Этот бот поможет вам обработать файлы для розыска автомобилей:

✅ **Основные функции:**
• Очищает адреса от лишней информации
• Извлекает номерные знаки из данных авто
• Фильтрует по региону (Москва и Подмосковье)
• Разделяет большие файлы на части по 2000 строк

🆕 **Новые возможности:**
• Фильтрация по типу адреса
• Фильтрация по типу авто (старое/новое)
• Множественный выбор фильтров
• Возможность перевыбора фильтров

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
  
  initUserState(chatId);

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

    // Получаем уникальные значения для фильтров
    await bot.editMessageText('🔍 Анализирую данные для фильтров...', {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });

    const uniqueValues = getUniqueValues(csvContent);
    
    // Сохраняем данные пользователя
    const userState = userStates.get(chatId);
    userState.fileName = fileName;
    userState.csvContent = csvContent;
    userState.availableAddressTypes = uniqueValues.addressTypes;
    userState.availableCarTypes = uniqueValues.carTypes;
    userState.state = STATES.WAITING_FILTER_CHOICE;

    await bot.deleteMessage(chatId, processingMsg.message_id);

    // Предлагаем выбор фильтров
    const filterMessage = `
📊 **Файл загружен и проанализирован!**

📈 **Статистика:**
• Найдено типов адресов: ${uniqueValues.addressTypes.length}
• Найдено типов авто: ${uniqueValues.carTypes.length}

🎛 **Хотите применить фильтры для более точной выборки?**

*Без фильтров будет обработан весь файл (только с географической фильтрацией по Москве и Подмосковью)*
    `;

    await bot.sendMessage(chatId, filterMessage, {
      parse_mode: 'Markdown',
      ...createFilterKeyboard()
    });

  } catch (error) {
    console.error('Error processing document:', error);
    await bot.sendMessage(chatId, `❌ ${error.message}`);
  }
}

// Обработчик callback запросов
async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const messageId = callbackQuery.message.message_id;
  
  initUserState(chatId);
  const userState = userStates.get(chatId);

  try {
    await bot.answerCallbackQuery(callbackQuery.id);

    if (data === 'filter_no') {
      // Обработка без фильтров
      userState.state = STATES.READY_TO_PROCESS;
      
      await bot.editMessageText('🔄 Обрабатываю файл без дополнительных фильтров...', {
        chat_id: chatId,
        message_id: messageId
      });

      await processAndSendFiles(chatId, userState, null);
      
    } else if (data === 'filter_yes') {
      // Начинаем выбор фильтров
      userState.state = STATES.SELECTING_ADDRESS_TYPE;
      
      const addressMessage = `
🏠 **Выберите типы адресов для фильтрации:**

*Можете выбрать несколько вариантов. Повторное нажатие снимет галочку.*

**Доступно типов:** ${userState.availableAddressTypes.length}
      `;

      await bot.editMessageText(addressMessage, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...createAddressTypeKeyboard(userState.availableAddressTypes, userState.selectedAddressTypes)
      });
      
    } else if (data.startsWith('addr_')) {
      // Обработка выбора типов адресов
      if (data === 'addr_back') {
        userState.state = STATES.WAITING_FILTER_CHOICE;
        
        const filterMessage = `
📊 **Файл загружен и проанализирован!**

🎛 **Хотите применить фильтры для более точной выборки?**
        `;

        await bot.editMessageText(filterMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          ...createFilterKeyboard()
        });
        
      } else if (data === 'addr_next') {
        userState.state = STATES.SELECTING_CAR_TYPE;
        
        const carMessage = `
🚗 **Выберите типы авто для фильтрации:**

*Можете выбрать несколько вариантов. Повторное нажатие снимет галочку.*

**Выбрано типов адресов:** ${userState.selectedAddressTypes.size}
**Доступно типов авто:** ${userState.availableCarTypes.length}
        `;

        await bot.editMessageText(carMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          ...createCarTypeKeyboard(userState.availableCarTypes, userState.selectedCarTypes)
        });
        
      } else {
        // Переключение выбора типа адреса
        const index = parseInt(data.replace('addr_', ''));
        const type = userState.availableAddressTypes[index];
        
        if (userState.selectedAddressTypes.has(type)) {
          userState.selectedAddressTypes.delete(type);
        } else {
          userState.selectedAddressTypes.add(type);
        }
        
        const addressMessage = `
🏠 **Выберите типы адресов для фильтрации:**

*Можете выбрать несколько вариантов. Повторное нажатие снимет галочку.*

**Выбрано:** ${userState.selectedAddressTypes.size} из ${userState.availableAddressTypes.length}
        `;

        await bot.editMessageText(addressMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          ...createAddressTypeKeyboard(userState.availableAddressTypes, userState.selectedAddressTypes)
        });
      }
      
    } else if (data.startsWith('car_')) {
      // Обработка выбора типов авто
      if (data === 'car_back') {
        userState.state = STATES.SELECTING_ADDRESS_TYPE;
        
        const addressMessage = `
🏠 **Выберите типы адресов для фильтрации:**

*Можете выбрать несколько вариантов. Повторное нажатие снимет галочку.*

**Выбрано:** ${userState.selectedAddressTypes.size} из ${userState.availableAddressTypes.length}
        `;

        await bot.editMessageText(addressMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          ...createAddressTypeKeyboard(userState.availableAddressTypes, userState.selectedAddressTypes)
        });
        
      } else if (data === 'car_apply') {
        // Применяем фильтры
        userState.state = STATES.READY_TO_PROCESS;
        
        const filters = {
          addressTypes: Array.from(userState.selectedAddressTypes),
          carTypes: Array.from(userState.selectedCarTypes)
        };
        
        await bot.editMessageText('🎯 Применяю выбранные фильтры и обрабатываю файл...', {
          chat_id: chatId,
          message_id: messageId
        });

        await processAndSendFiles(chatId, userState, filters);
        
      } else {
        // Переключение выбора типа авто
        const index = parseInt(data.replace('car_', ''));
        const type = userState.availableCarTypes[index];
        
        if (userState.selectedCarTypes.has(type)) {
          userState.selectedCarTypes.delete(type);
        } else {
          userState.selectedCarTypes.add(type);
        }
        
        const carMessage = `
🚗 **Выберите типы авто для фильтрации:**

*Можете выбрать несколько вариантов. Повторное нажатие снимет галочку.*

**Выбрано типов адресов:** ${userState.selectedAddressTypes.size}
**Выбрано типов авто:** ${userState.selectedCarTypes.size} из ${userState.availableCarTypes.length}
        `;

        await bot.editMessageText(carMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          ...createCarTypeKeyboard(userState.availableCarTypes, userState.selectedCarTypes)
        });
      }
      
    } else if (data === 'reselect_filters') {
      // Перевыбор фильтров
      userState.selectedAddressTypes.clear();
      userState.selectedCarTypes.clear();
      userState.state = STATES.WAITING_FILTER_CHOICE;
      
      const filterMessage = `
🔄 **Перевыбор фильтров**

🎛 **Хотите применить фильтры для более точной выборки?**
      `;

      await bot.editMessageText(filterMessage, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        ...createFilterKeyboard()
      });
    }

  } catch (error) {
    console.error('Error handling callback query:', error);
    await bot.sendMessage(chatId, '❌ Произошла ошибка при обработке выбора.');
  }
}

// Обработка и отправка файлов
async function processAndSendFiles(chatId, userState, filters) {
  try {
    const result = await processCSVInAppsScript(userState.csvContent, userState.fileName, filters);

    if (result.success) {
      // Отправляем информацию о результате
      let filterInfo = '';
      if (filters) {
        filterInfo = `
🎯 **Примененные фильтры:**
• Типы адресов: ${filters.addressTypes.length > 0 ? filters.addressTypes.join(', ') : 'Все'}
• Типы авто: ${filters.carTypes.length > 0 ? filters.carTypes.join(', ') : 'Все'}
        `;
      }

      const resultMessage = `
✅ **Файл успешно обработан!**
${filterInfo}
📊 **Статистика:**
• Всего строк после фильтрации: ${result.totalRows}
• Создано частей: ${result.partsCount}

📁 **Отправляю обработанные файлы...**
      `;

      await bot.sendMessage(chatId, resultMessage, { parse_mode: 'Markdown' });

      // Отправляем инструкцию
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

      // Отправляем кнопку для перевыбора фильтров
      const finalMessage = `
🎉 **Все файлы отправлены!**

Можете загружать их в Google My Maps или перевыбрать фильтры для получения новых файлов.
      `;

      await bot.sendMessage(chatId, finalMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Перевыбрать фильтры', callback_data: 'reselect_filters' }]
          ]
        }
      });

    } else {
      await bot.sendMessage(chatId, `❌ Ошибка обработки: ${result.error}`);
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
      <title>Rozysk Avto Bot v6.0</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 50px; text-align: center; background: #f0f0f0; }
        .container { max-width: 700px; margin: 0 auto; background: white; padding: 40px; border-radius: 15px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
        .status { color: #4CAF50; font-size: 28px; font-weight: bold; margin-bottom: 20px; }
        .version { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px; border-radius: 10px; margin: 20px 0; }
        .features { background: #f8f9fa; padding: 15px; border-radius: 10px; margin: 15px 0; text-align: left; }
        .new-badge { background: #ff6b6b; color: white; padding: 3px 8px; border-radius: 12px; font-size: 12px; margin-left: 10px; }
        .info { color: #666; margin-top: 25px; line-height: 1.8; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚗 Rozysk Avto Bot</h1>
        <div class="status">✅ Сервис работает!</div>
        
        <div class="version">
          <h3>📦 Версия 6.0 <span class="new-badge">NEW</span></h3>
          <p>Система умной фильтрации данных</p>
        </div>
        
        <div class="features">
          <h4>🆕 Новые возможности:</h4>
          <ul>
            <li>🗺️ Автофильтрация по региону (Москва + Подмосковье)</li>
            <li>🏠 Фильтрация по типам адресов (множественный выбор)</li>
            <li>🚗 Фильтрация по типам авто (старое/новое)</li>
            <li>✅ Интерактивные галочки для выбора</li>
            <li>🔄 Возможность перевыбора фильтров</li>
            <li>🔙 Навигация "Назад" по меню</li>
          </ul>
        </div>
        
        <div class="info">
          <p><strong>🤖 Telegram:</strong> <a href="https://t.me/rozysk_avto_bot">@rozysk_avto_bot</a></p>
          <p><strong>📎 Форматы:</strong> CSV, Excel (xlsx, xls)</p>
          <p><strong>🕐 Онлайн:</strong> ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get('/doget', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '6.0',
    message: 'Rozysk Avto Bot v6.0 with smart filtering',
    webhook: WEBHOOK_URL,
    timestamp: new Date().toISOString(),
    features: [
      'Regional filtering (Moscow + Moscow region)',
      'Address type filtering with multi-select',
      'Car type filtering (old/new)',
      'Interactive checkboxes',
      'Filter reselection capability',
      'Back navigation'
    ]
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
  console.log(`🎯 Features: Regional + Type filtering, Multi-select UI`);
  
  await setupWebhook();
  
  console.log('✅ Telegram bot v6.0 with smart filtering is ready!');
});
