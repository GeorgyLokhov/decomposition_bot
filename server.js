const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// URL вашего Google Apps Script
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

app.post('/webhook', async (req, res) => {
  try {
    // Просто перенаправляем в Google Apps Script
    await axios.post(GOOGLE_SCRIPT_URL, req.body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(200).send('OK'); // Возвращаем OK даже при ошибке
  }
});

app.get('/', (req, res) => {
  res.send('Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
