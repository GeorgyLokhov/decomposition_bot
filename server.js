const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 10000;

// Конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://rozysk-avto-bot.onrender.com/webhook/${BOT_TOKEN}`;

// Максимальный размер файла (в байтах) - 5MB для надежности
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

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
      timeout: 30000,
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
    }
    
    if (error.response && error.response.status === 500) {
      throw new Error('Ошибка обработки файла в Google Apps Script. Попробуйте файл меньшего размера или другой формат.');
    }
    
    throw error;
  }
}

// Форматируем размер файла для отображения
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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
• Максимальный размер файла: 5MB
• Для больших файлов используйте CSV формат

📤 **Просто отправьте мне файл для обработки!**
  `;
  
  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
}

// Обработчик документов
async function handleDocument(chatId, document) {
  const fileName = document.file_name;
  const fileSize = document.file_size;

  try {
    console.log(`Processing document: ${fileName}, size: ${fileSize} bytes`);

    // Проверяем размер файла (только реальный размер, не base64)
    if (fileSize > MAX_FILE_SIZE) {
      await bot.sendMessage(chatId, 
        `❌ Файл слишком большой (${formatFileSize(fileSize)}). ` +
        `Максимальный размер: ${formatFileSize(MAX_FILE_SIZE)}\n\n` +
        `💡 Попробуйте:\n` +
        `• Сохранить файл в формате CSV\n` +
        `• Разделить данные на несколько файлов`
      );
      return;
    }

    // Проверяем формат файла
    if (!isSupportedFile(fileName)) {
      await bot.sendMessage(chatId, '❌ Поддерживаются только файлы: CSV, Excel (.xlsx, .xls)');
      return;
    }

    // Отправляем сообщение о начале обработки
    const processingMsg = await bot.sendMessage(chatId, 
      `⏳ Загружаю файл "${fileName}" (${formatFileSize(fileSize)})...`
    );

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

    // Отправляем на обработку в Apps Script
    await bot.editMessageText('🔄 Обрабатываю данные в облаке...\n⏱️ Это может занять несколько минут', {
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
• Исходный файл: ${fileName} (${formatFileSize(fileSize)})
• Всего строк данных: ${result.totalRows}
• Создано частей: ${result.partsCount}

📁 **Отправляю обработанные файлы...**
      `;

      await bot.sendMessage(chatId, resultMessage, { parse_mode: 'Markdown' });

      // Отправляем файлы сразу без дополнительной инструкции
      for (let i = 0; i < result.files.length; i++) {
        const file = result.files[i];
        const buffer = Buffer.from(file.content, 'base64');
        
        await bot.sendDocument(chatId, buffer, {
          filename: file.name,
          caption: i === 0 ? '📄 Обработанные данные готовы!' : undefined
        });

        // Небольшая задержка между отправками
        if (i < result.files.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Отправляем инструкцию после всех файлов
      const instructionMessage = `
🎉 **Все файлы отправлены!**

💡 **Инструкция по использованию:**

1️⃣ Сохраните полученные файлы на свое устройство
2️⃣ Перейдите в [Google My Maps](https://mymaps.google.com)
3️⃣ Создайте новую карту
4️⃣ Загружайте каждый файл по отдельности
5️⃣ Адреса автоматически преобразуются в точки на карте

🎯 **Каждый файл содержит до 2000 записей для оптимальной работы с картами**

✨ **Что было сделано:**
• Очищены адреса от номеров квартир/офисов
• Извлечены номерные знаки в отдельную колонку
• Добавлена геопривязка (Москва/МО)
      `;

      await bot.sendMessage(chatId, instructionMessage, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });

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
    } else if (error.message.includes('500')) {
      errorMessage = '❌ Ошибка сервера обработки. Попробуйте позже или используйте другой файл.';
    } else if (error.message.includes('maxContentLength')) {
      errorMessage = '❌ Файл слишком большой для обработки. Максимальный размер: 5MB';
    }
    
    await bot.sendMessage(chatId, errorMessage);
  }
}

// Обработчик других сообщений
async function handleMessage(chatId, text) {
  if (text && !text.startsWith('/')) {
    await bot.sendMessage(chatId, 
      '📎 Отправьте файл для обработки (CSV или Excel)\n\n' +
      '⚠️ Максимальный размер: 5MB\n' +
      '💡 Для больших файлов используйте CSV формат'
    );
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
    res.status(200).send('OK'); // Всегда возвращаем 200, чтобы Telegram не повторял запрос
  }
});

// Основные routes
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Rozysk Avto Bot</title>
      <meta charset="UTF-8">
      <style>
        body { 
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
          margin: 0; 
          padding: 50px; 
          text-align: center; 
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          min-height: 100vh;
        }
        .container { 
          background: rgba(255,255,255,0.1); 
          border-radius: 20px; 
          padding: 40px; 
          backdrop-filter: blur(10px);
          max-width: 600px;
          margin: 0 auto;
        }
        .status { color: #4CAF50; font-size: 24px; margin: 20px 0; }
        .info { margin-top: 30px; font-size: 16px; }
        .info a { color: #FFD700; text-decoration: none; }
        .info a:hover { text-decoration: underline; }
        .icon { font-size: 48px; margin-bottom: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">🚗</div>
        <h1>Rozysk Avto Bot</h1>
        <div class="status">✅ Сервис работает!</div>
        <div class="info">
          <p>🤖 Перейдите в Telegram: <a href="https://t.me/rozysk_avto_bot">@rozysk_avto_bot</a></p>
          <p>🔗 Webhook: Активен</p>
          <p>⚡ Максимальный размер файла: 5MB</p>
          <p>📊 Поддерживаемые форматы: CSV, Excel</p>
        </div>
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
    maxFileSize: formatFileSize(MAX_FILE_SIZE),
    timestamp: new Date().toISOString()
  });
});

app.post('/dopost', (req, res) => {
  res.json({ 
    status: 'ok', 
    received: req.body,
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'rozysk-avto-bot',
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

// Обработка необработанных исключений
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Запуск сервера
app.listen(port, async () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📡 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`📁 Max file size: ${formatFileSize(MAX_FILE_SIZE)}`);
  
  // Устанавливаем webhook
  await setupWebhook();
  
  console.log('✅ Telegram bot is ready with webhook!');
});
