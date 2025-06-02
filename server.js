const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

app.post('/webhook', async (req, res) => {
  try {
    if (GOOGLE_SCRIPT_URL) {
      await axios.post(GOOGLE_SCRIPT_URL, req.body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error:', error.message);
    res.status(200).send('OK');
  }
});

app.get('/', (req, res) => {
  res.send('Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
