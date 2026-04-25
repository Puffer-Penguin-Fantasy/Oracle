const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

// Optional: protect with a secret
const SYNC_SECRET = process.env.SYNC_SECRET || null;

app.get('/sync', (req, res) => {
  if (SYNC_SECRET && req.query.secret !== SYNC_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  console.log(`\n🔔 Sync triggered: ${new Date().toISOString()}`);
  res.send('Sync started in parallel.');

  exec(`node sync-steps.js`, { timeout: 220000 }, (err, stdout, stderr) => {
    if (err) console.error(`❌ sync-steps.js error: ${err.message}`);
    if (stdout) console.log(`[sync-steps.js] ${stdout}`);
    if (stderr) console.error(`[sync-steps.js] ${stderr}`);
    console.log('✅ Sync cycle done.');
  });
});

app.get('/keep-alive', (req, res) => {
  res.send('Stayin Alive! 🕺');
});

app.get('/', (req, res) => {
  res.send('Puffer Oracle is Live 🏃‍♂️');
});

// Self-ping every 10 minutes to stay awake on Render
const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
setInterval(() => {
  axios.get(`${APP_URL}/keep-alive`)
    .then(() => console.log('💓 Keep-alive ping successful'))
    .catch(err => console.error('💔 Keep-alive ping failed:', err.message));
}, 10 * 60 * 1000);

app.listen(port, () => {
  console.log(`🚀 Oracle Web Server listening at http://localhost:${port}`);
  console.log(`📡 Keep-alive active for: ${APP_URL}`);
});
