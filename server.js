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
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

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

// Конвертируем файл в base64
async function fileToBase64(fileUrl) {
  try {
    console.log('Downloading file from:', fileUrl);
    const response = await axios.get(fileUrl, { 
      responseType: 'arraybuffer',
      timeout: 60000
    });
    
    console.log('File downloaded, size:', response.data.byteLength, 'bytes');
    const base64 = Buffer.from(response.data).toString('base64');
    
    return base64;
  } catch (error) {
    console.error('Error converting file to base64:', error);
    throw error;
  }
}

// НОВАЯ ФУНКЦИЯ: Конвертация Excel в CSV на сервере
function convertExcelToCSV(buffer, fileName) {
  try {
    console.log('Converting Excel to CSV on server...');
    
    // Читаем Excel файл
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    
    // Берем первый лист
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Конвертируем в CSV
    const csvContent = XLSX.utils.sheet_to_csv(worksheet);
    
    console.log('Excel converted to CSV successfully, length:', csvContent.length);
    return csvContent;
    
  } catch (error) {
    console.error('Error converting Excel to CSV:', error);
    throw new Error('Не удалось конвертировать Excel файл: ' + error.message);
  }
}

// Отправляем CSV на обработку в Apps Script
async function processCSVInAppsScript(csvContent, fileName) {
  try {
    console.log(`Sending CSV to Apps Script: ${fileName}, length: ${csvContent.length}`);
    
    // Кодируем CSV в base64
    const base64Content = Buffer.from(csvContent, 'utf8').toString('base64');
    
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: 'process_csv',
      csvContent: base64Content,
      fileName: fileName
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 300000 // 5 минут
    });

    console.log('Apps Script response received');
    return response.data;
  } catch (error) {
    console.error('Error processing CSV in Apps Script:', error);
    
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    
    throw new Error('Ошибка обработки в Google Apps Script. Попробуйте еще раз.');
  }
}

// Обработчик команды /start
async function handleStart(chatId) {
  const welcomeMessage = `
🚗 **Добро пожаловать в Rozysk Avto Bot v5.0!**

Этот бот поможет вам обработать файлы для розыска автомобилей:

✅ **Что я умею:**
• Очищать адреса от лишней информации
• Извлекать номерные знаки из данных авто
• Разделять большие файлы на части по 2000 строк
• Добавлять геопривязку для карт

📎 **Поддерживаемые форматы:**
• CSV (.csv)
• Excel (.xlsx, .xls)

📤 **Просто отправьте мне файл для обработки!**

🔧 **Что нового:**
• Улучшена обработка Excel файлов
• Исправлены проблемы с конвертацией
• Более быстрая обработка данных
  `;
  
  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
}

// Обработчик документов
async function handleDocument(chatId, document) {
  const fileName = document.file_name;
  const fileSize = document.file_size;

  console.log(`Processing document: ${fileName}, size: ${fileSize} bytes`);

  try {
    // Проверяем формат файла
    if (!isSupportedFile(fileName)) {
      await bot.sendMessage(chatId, '❌ Поддерживаются только файлы: CSV, Excel (.xlsx, .xls)');
      return;
    }

    // Отправляем сообщение о начале обработки
    const processingMsg = await bot.sendMessage(chatId, '⏳ Загружаю файл...');

    // Получаем ссылку на файл
    const fileInfo = await bot.getFile(document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;

    // Загружаем файл
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
      // CSV файл - читаем как есть
      csvContent = fileBuffer.toString('utf8');
    } else {
      // Excel файл - конвертируем на сервере
      await bot.editMessageText('🔄 Конвертирую Excel в CSV...', {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
      
      csvContent = convertExcelToCSV(fileBuffer, fileName);
    }

    // Отправляем на обработку в Apps Script
    await bot.editMessageText('☁️ Обрабатываю данные в облаке...', {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });

    const result = await processCSVInAppsScript(csvContent, fileName);

    if (result.success) {
      // Удаляем сообщение о обработке
      await bot.deleteMessage(chatId, processingMsg.message_id);

      // Отправляем информацию о результате
      const resultMessage = `
✅ **Файл успешно обработан!**

📊 **Статистика:**
• Всего строк: ${result.totalRows}
• Создано частей: ${result.partsCount}

📁 **Получаю обработанные файлы...**
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
        
        await bot.sendDocument(chatId, buffer, {
          filename: file.name
        });

        // Небольшая задержка между отправками
        if (i < result.files.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }

      await bot.sendMessage(chatId, '🎉 Все файлы отправлены! Можете загружать их в Google My Maps.');

    } else {
      await bot.editMessageText(`❌ Ошибка обработки: ${result.error}`, {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
    }

  } catch (error) {
    console.error('Error processing document:', error);
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

      // Обработка команд
      if (message.text === '/start') {
        await handleStart(chatId);
      }
      // Обработка документов
      else if (message.document) {
        await handleDocument(chatId, message.document);
      }
      // Обработка текстовых сообщений
      else if (message.text) {
        await handleMessage(chatId, message.text);
      }
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
      <title>Rozysk Avto Bot v5.0</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 50px; text-align: center; background: #f0f0f0; }
        .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .status { color: #4CAF50; font-size: 24px; font-weight: bold; }
        .info { color: #666; margin-top: 20px; line-height: 1.6; }
        .version { background: #e3f2fd; padding: 10px; border-radius: 5px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚗 Rozysk Avto Bot</h1>
        <div class="status">✅ Сервис работает!</div>
        <div class="version">
          <strong>Версия 5.0</strong><br>
          • Улучшена обработка Excel файлов<br>
          • Конвертация на сервере<br>
          • Исправлены ошибки Apps Script
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
    message: 'Rozysk Avto Bot v5.0 is running',
    webhook: WEBHOOK_URL,
    timestamp: new Date().toISOString(),
    features: [
      'Excel conversion on server',
      'Improved error handling',
      'Better performance'
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
  console.log(`🚀 Server v5.0 running on port ${port}`);
  console.log(`📡 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`🔧 Excel conversion: ON SERVER`);
  
  // Устанавливаем webhook
  await setupWebhook();
  
  console.log('✅ Telegram bot v5.0 is ready!');
});
