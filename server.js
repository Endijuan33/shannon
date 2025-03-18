require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');

const { handler: faucetHandler } = require('./netlify/functions/faucet');
const { handler: balanceHandler } = require('./netlify/functions/balance');

const app = express();
app.use(bodyParser.json());

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/.netlify/functions/faucet', async (req, res) => {
  const event = {
    httpMethod: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body)
  };

  try {
    const result = await faucetHandler(event, {});
    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value);
      }
    }
    res.status(result.statusCode).send(result.body);
  } catch (error) {
    console.error('Error in faucet function:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/.netlify/functions/balance', async (req, res) => {
  const event = {
    httpMethod: 'GET',
    headers: req.headers,
    body: null
  };

  try {
    const result = await balanceHandler(event, {});
    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value);
      }
    }
    res.status(result.statusCode).send(result.body);
  } catch (error) {
    console.error('Error in balance function:', error);
    res.status(500).send('Internal Server Error');
  }
});

const HTTP_PORT = process.env.PORT || 3000;
app.listen(HTTP_PORT, () => {
  console.log(`HTTP Server running on http://localhost:${HTTP_PORT}`);
});

const HTTPS_PORT = 8443;
try {
  const privateKey = fs.readFileSync(path.join(__dirname, 'key.pem'), 'utf8');
  const certificate = fs.readFileSync(path.join(__dirname, 'cert.pem'), 'utf8');
  const credentials = { key: privateKey, cert: certificate };

  https.createServer(credentials, app).listen(HTTPS_PORT, () => {
    console.log(`HTTPS Server running on https://localhost:${HTTPS_PORT}`);
  });
} catch (error) {
  console.error("Could not start HTTPS server: ", error.message);
}
