const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram Bot Token из переменных окружения
const BOT_TOKEN = process.env.BOT_TOKEN;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Настройка multer для временного хранения файлов
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(express.json());

// Обработчики бота
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `
🤖 Добро пожаловать в бот розыска авто!

📁 Отправьте файл (.xlsx, .xls, .csv) для обработки.

ℹ️ Бот автоматически:
• Очистит адреса
• Извлечет номерные знаки
• Разделит данные на части по 2000 строк
• Подготовит файлы для Google My Maps

Просто отправьте ваш файл!
  `;
  
  bot.sendMessage(chatId, welcomeMessage);
});

// Обработка документов
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const document = msg.document;
  
  try {
    // Проверяем формат файла
    const allowedExtensions = ['.xlsx', '.xls', '.csv'];
    const fileExtension = document.file_name.slice(document.file_name.lastIndexOf('.')).toLowerCase();
    
    if (!allowedExtensions.includes(fileExtension)) {
      bot.sendMessage(chatId, '❌ Поддерживаются только файлы: .xlsx, .xls, .csv');
      return;
    }
    
    bot.sendMessage(chatId, '⏳ Обрабатываю файл...');
    
    // Скачиваем файл
    const fileLink = await bot.getFileLink(document.file_id);
    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const fileBuffer = Buffer.from(response.data);
    
    // Конвертируем в base64
    const fileBase64 = fileBuffer.toString('base64');
    
    // Отправляем в Google Apps Script
    const appsScriptResponse = await axios.post(APPS_SCRIPT_URL, {
      action: 'process_file',
      fileData: fileBase64,
      filename: document.file_name,
      userId: chatId
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 300000 // 5 минут
    });
    
    const result = appsScriptResponse.data;
    
    if (!result.success) {
      throw new Error(result.error || 'Ошибка обработки файла');
    }
    
    // Отправляем результаты
    bot.sendMessage(chatId, `
✅ Файл обработан успешно!

📊 Всего строк: ${result.totalRows}
📁 Частей: ${result.chunks}

📥 Загружаю обработанные файлы...
    `);
    
    // Отправляем каждую часть как CSV файл
    for (let i = 0; i < result.data.length; i++) {
      const chunk = result.data[i];
      const csvContent = convertToCSV(chunk);
      
      const filename = `${i + 1}_часть_розыска_авто.csv`;
      
      // Создаем временный файл
      const tempFilePath = `uploads/${filename}`;
      fs.writeFileSync(tempFilePath, csvContent, 'utf8');
      
      // Отправляем файл
      await bot.sendDocument(chatId, tempFilePath, {
        caption: `📁 Часть ${i + 1} из ${result.chunks}`
      });
      
      // Удаляем временный файл
      fs.unlinkSync(tempFilePath);
      
      // Небольшая задержка между отправками
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    bot.sendMessage(chatId, `
🎉 Все файлы отправлены!

💡 Инструкция:
1. Перейдите на maps.google.com
2. Нажмите "Создать карту"
3. Импортируйте каждый файл отдельно
4. Выберите столбец с адресами для геолокации

✨ Готово! Ваши данные на карте.
    `);
    
  } catch (error) {
    console.error('Ошибка обработки файла:', error);
    bot.sendMessage(chatId, `❌ Ошибка: ${error.message}`);
  }
});

// Функция конвертации в CSV
function convertToCSV(data) {
  return data.map(row => 
    row.map(cell => {
      const cellStr = String(cell || '');
      // Экранируем кавычки и запятые
      if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
        return `"${cellStr.replace(/"/g, '""')}"`;
      }
      return cellStr;
    }).join(',')
  ).join('\n');
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Bot is running', timestamp: new Date().toISOString() });
});

// Webhook endpoint (если нужен)
app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
