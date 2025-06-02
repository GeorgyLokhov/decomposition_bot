const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// URL вашего Google Apps Script веб-приложения
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxI8dkjhlh5n0EmFdJ06P8lbHIdYghGRwViIljZbIS5ZOoskIiHrvaKqWXLSkm7d0-7Ng/exec';

app.post('/webhook', async (req, res) => {
  try {
    // Перенаправляем запрос в Google Apps Script
    await axios.post(GOOGLE_SCRIPT_URL, req.body, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error');
  }
});

app.get('/', (req, res) => {
  res.send('Rozysk Avto Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// URL вашего Google Apps Script веб-приложения
const GOOGLE_SCRIPT_URL = 'ВАШ_URL_ИЗ_ШАГА_4';

app.post('/webhook', async (req, res) => {
  try {
    // Перенаправляем запрос в Google Apps Script
    await axios.post(GOOGLE_SCRIPT_URL, req.body, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error');
  }
});

app.get('/', (req, res) => {
  res.send('Rozysk Avto Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
