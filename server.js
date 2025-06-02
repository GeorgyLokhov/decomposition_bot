const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 10000;

// Конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://rozysk-avto-bot.onrender.com/webhook/${BOT_TOKEN}`;

// Максимальный размер файла (в байтах) - увеличили лимиты
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5MB в base64 (~3.75MB исходный файл)

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
      timeout: 60000,
      maxContentLength: MAX_FILE_SIZE
    });
    
    console.log('File downloaded, size:', response.data.byteLength, 'bytes');
    const base64 = Buffer.from(response.data).toString('base64');
    console.log('Base64 string length:', base64.length);
    
    return base64;
  } catch (error) {
    console.error('Error converting file to base64:', error);
    throw error;
  }
}

// Отправляем файл на обработку в Apps Script
async function processFileInAppsScript(fileContent, fileName, fileType) {
  try {
    console.log(`Sending to Apps Script: ${fileName}, base64 length: ${fileContent.length}`);
    
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: 'process_file',
      fileContent: fileContent,
      fileName: fileName,
      fileType: fileType
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 300000, // 5 минут
      maxContentLength: 50 * 1024 * 1024 // 50MB
    });

    console.log('Apps Script response received');
    return response.data;
  } catch (error) {
    console.error('Error processing file in Apps Script:', error);
    
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
      
      if (error.response.status === 500) {
        throw new Error('Ошибка обработки в Google Apps Script. Файл может быть поврежден или слишком сложен для обработки.');
      }
    }
    
    if (error.message.includes('timeout')) {
      throw new Error('Превышено время обработки. Попробуйте файл меньшего размера.');
    }
    
    throw error;
  }
}

// Обработчик команды /start
async function handleStart(chatId) {
  const welcomeMessage = `
🚗 **Добро пожаловать в Rozysk Avto Bot!**

Этот бот поможет вам обработать файлы для розыска автомобилей:

✅ **Что я умею:**
• Очищать адреса от лишней информации
• Извлекать номерные знаки из данных авто
• Разделять большие файлы на части по 2000 строк
• Добавлять геопривязку для карт

📎 **Поддерживаемые форматы:**
• CSV (.csv)
• Excel (.xlsx, .xls)

⚠️ **Ограничения:**
• Максимальный размер файла: 20MB
• Рекомендуемый размер: до 5MB

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
    // Проверяем размер файла
    if (fileSize > MAX_FILE_SIZE) {
      await bot.sendMessage(chatId, `❌ Файл слишком большой (${Math.round(fileSize/1024/1024*100)/100}MB). Максимальный размер: 20MB`);
      return;
    }

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

    // Конвертируем в base64
    await bot.editMessageText('📤 Конвертирую файл...', {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });

    const fileContent = await fileToBase64(fileUrl);
    const fileType = getFileType(fileName);

    // Более разумная проверка размера base64 (увеличили лимит)
    if (fileContent.length > MAX_BASE64_SIZE) {
      await bot.editMessageText(`❌ Файл слишком большой для обработки (${Math.round(fileContent.length/1024/1024*100)/100}MB после кодирования). Попробуйте файл меньшего размера.`, {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
      return;
    }

    // Отправляем на обработку в Apps Script
    await bot.editMessageText('🔄 Обрабатываю данные в облаке... Это может занять несколько минут.', {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });

    const result = await processFileInAppsScript(fileContent, fileName, fileType);

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
    
    let errorMessage = '❌ Произошла ошибка при обработке файла.';
    
    if (error.message.includes('timeout')) {
      errorMessage = '❌ Превышено время ожидания. Попробуйте файл меньшего размера.';
    } else if (error.message.includes('Apps Script')) {
      errorMessage = `❌ ${error.message}`;
    }
    
    await bot.sendMessage(chatId, errorMessage);
  }
}

// Обработчик других сообщений
async function handleMessage(chatId, text) {
  if (text && !text.startsWith('/')) {
    await bot.sendMessage(chatId, '📎 Отправьте файл для обработки (CSV или Excel)\n\n⚠️ Максимальный размер: 20MB');
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
      <title>Rozysk Avto Bot</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 50px; text-align: center; }
        .status { color: green; font-size: 24px; }
        .info { color: #666; margin-top: 20px; }
      </style>
    </head>
    <body>
      <h1>🚗 Rozysk Avto Bot</h1>
      <div class="status">✅ Сервис работает!</div>
      <div class="info">
        <p>Перейдите в Telegram: <a href="https://t.me/rozysk_avto_bot">@rozysk_avto_bot</a></p>
        <p>Webhook URL: ${WEBHOOK_URL}</p>
        <p>Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</p>
      </div>
    </body>
    </html>
  `);
});

app.get('/doget', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Rozysk Avto Bot server is running',
    webhook: WEBHOOK_URL,
    timestamp: new Date().toISOString(),
    limits: {
      maxFileSize: `${MAX_FILE_SIZE / 1024 / 1024}MB`,
      maxBase64Size: `${MAX_BASE64_SIZE / 1024 / 1024}MB`
    }
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
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📡 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`📏 Limits: File ${MAX_FILE_SIZE/1024/1024}MB, Base64 ${MAX_BASE64_SIZE/1024/1024}MB`);
  
  // Устанавливаем webhook
  await setupWebhook();
  
  console.log('✅ Telegram bot is ready with webhook!');
});
