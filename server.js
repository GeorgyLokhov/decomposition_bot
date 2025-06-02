const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const port = process.env.PORT || 3000;

// Конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN; // Добавим в секреты Render
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // URL из Apps Script

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Хранилище состояний пользователей
const userStates = new Map();

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
async function fileToBase64(fileUrl, filename) {
  try {
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const base64 = Buffer.from(response.data).toString('base64');
    return base64;
  } catch (error) {
    console.error('Error converting file to base64:', error);
    throw error;
  }
}

// Отправляем файл на обработку в Apps Script
async function processFileInAppsScript(fileContent, fileName, fileType) {
  try {
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: 'process_file',
      fileContent: fileContent,
      fileName: fileName,
      fileType: fileType
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    console.error('Error processing file in Apps Script:', error);
    throw error;
  }
}

// Очищаем возможные webhook
bot.deleteWebhook().then(() => {
  console.log('Webhook cleared successfully');
}).catch((err) => {
  console.log('Webhook clear error:', err.message);
});

// Команда /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  
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

📤 **Просто отправьте мне файл для обработки!**
  `;
  
  bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

// Обработка документов
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const document = msg.document;
  const fileName = document.file_name;

  try {
    // Проверяем формат файла
    if (!isSupportedFile(fileName)) {
      bot.sendMessage(chatId, '❌ Поддерживаются только файлы: CSV, Excel (.xlsx, .xls)');
      return;
    }

    // Отправляем сообщение о начале обработки
    const processingMsg = await bot.sendMessage(chatId, '⏳ Обрабатываю файл...');

    // Получаем ссылку на файл
    const fileInfo = await bot.getFile(document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;

    // Конвертируем в base64
    const fileContent = await fileToBase64(fileUrl, fileName);
    const fileType = getFileType(fileName);

    // Отправляем на обработку в Apps Script
    bot.editMessageText('🔄 Обрабатываю данные в облаке...', {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });

    const result = await processFileInAppsScript(fileContent, fileName, fileType);

    if (result.success) {
      // Удаляем сообщение о обработке
      bot.deleteMessage(chatId, processingMsg.message_id);

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
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      await bot.sendMessage(chatId, '🎉 Все файлы отправлены! Можете загружать их в Google My Maps.');

    } else {
      bot.editMessageText(`❌ Ошибка обработки: ${result.error}`, {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
    }

  } catch (error) {
    console.error('Error processing document:', error);
    bot.sendMessage(chatId, `❌ Произошла ошибка: ${error.message}`);
  }
});

// Обработка других типов сообщений
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  
  if (msg.text && !msg.text.startsWith('/')) {
    bot.sendMessage(chatId, '📎 Отправьте файл для обработки (CSV или Excel)');
  }
});

// Обработка ошибок бота
bot.on('error', (error) => {
  console.error('Telegram bot error:', error);
});

// Express routes
app.get('/', (req, res) => {
  res.send('Rozysk Avto Bot is running!');
});

app.get('/doget', (req, res) => {
  res.json({ status: 'ok', message: 'Rozysk Avto Bot server is running' });
});

app.post('/dopost', (req, res) => {
  res.json({ status: 'ok', received: req.body });
});

// Запуск сервера
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('Telegram bot is polling...');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down bot...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down bot...');
  bot.stopPolling();  
  process.exit(0);
});

