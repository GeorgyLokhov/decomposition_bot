const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// URL вашего Google Apps Script
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

console.log('Starting Rozysk Avto Bot...');
console.log('Google Script URL:', GOOGLE_SCRIPT_URL ? 'Set' : 'Not set');

app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));
    
    if (!GOOGLE_SCRIPT_URL) {
      console.error('GOOGLE_SCRIPT_URL not set');
      return res.status(500).send('Configuration error');
    }
    
    // Быстро отвечаем Telegram
    res.status(200).send('OK');
    
    // Асинхронно отправляем в Google Apps Script
    axios.post(GOOGLE_SCRIPT_URL, req.body, {
      headers: { 
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }).then(response => {
      console.log('Successfully sent to Google Apps Script');
    }).catch(error => {
      console.error('Error sending to Google Apps Script:', error.message);
    });
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).send('OK'); // Всегда отвечаем OK для Telegram
  }
});

app.get('/', (req, res) => {
  res.send(`
    <h1>🤖 Rozysk Avto Bot</h1>
    <p>Status: <strong>Running</strong></p>
    <p>Time: ${new Date().toISOString()}</p>
    <p>Google Script URL: ${GOOGLE_SCRIPT_URL ? '✅ Set' : '❌ Not set'}</p>
  `);
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    time: new Date().toISOString(),
    google_script_configured: !!GOOGLE_SCRIPT_URL
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 Webhook endpoint: /webhook`);
  console.log(`🌐 Health check: /health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
