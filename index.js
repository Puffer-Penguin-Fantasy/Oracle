const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');
const nodemailer = require('nodemailer');
require('dotenv').config();
const app = express();
const port = process.env.PORT || 3000;

// Optional: protect with a secret
const SYNC_SECRET = process.env.SYNC_SECRET || null;

// ENDPOINT 1: Sync Fitbit data (Run every 2 mins)
app.get('/sync', (req, res) => {
  if (SYNC_SECRET && req.query.secret !== SYNC_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  console.log(`\n🔔 Fitbit Sync triggered: ${new Date().toISOString()}`);
  res.send('Fitbit sync started.');

  exec(`node sync-steps.js`, { timeout: 600000 }, (err, stdout, stderr) => {
    if (err) console.error(`❌ sync-steps.js error: ${err.message}`);
    if (stdout) console.log(`[sync-steps.js] ${stdout}`);
    if (stderr) console.error(`[sync-steps.js] ${stderr}`);
    console.log('🏁 Fitbit Sync complete.');
  });
});

// ENDPOINT 2: Blockchain Notarization (Run every 3 hours)
app.get('/notarize', (req, res) => {
  if (SYNC_SECRET && req.query.secret !== SYNC_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  console.log(`\n🚀 Blockchain Notarization triggered: ${new Date().toISOString()}`);
  res.send('Notarization started.');

  exec(`node oracle.js`, { timeout: 600000 }, (oErr, oStdout, oStderr) => {
    if (oErr) console.error(`❌ oracle.js error: ${oErr.message}`);
    if (oStdout) console.log(`[oracle.js] ${oStdout}`);
    if (oStderr) console.error(`[oracle.js] ${oStderr}`);
    
    console.log('✅ Notarization complete. Updating Global Leaderboard...');
    
    exec(`node update-leaderboard.js`, { timeout: 300000 }, (lErr, lStdout, lStderr) => {
      if (lErr) console.error(`❌ update-leaderboard.js error: ${lErr.message}`);
      if (lStdout) console.log(`[update-leaderboard.js] ${lStdout}`);
      if (lStderr) console.error(`[update-leaderboard.js] ${lStderr}`);
      console.log('🏁 Full Notarization cycle done.');
    });
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

app.listen(port, async () => {
  console.log(`🚀 Oracle Web Server listening at http://localhost:${port}`);
  console.log(`📡 Keep-alive active for: ${APP_URL}`);

  // --- Send Deployment Confirmation Email ---
  const { EMAIL_USER, EMAIL_PASS, EMAIL_TO } = process.env;
  if (EMAIL_USER && EMAIL_PASS && EMAIL_TO) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    });

    try {
      await transporter.sendMail({
        from: `"Puffer System" <${EMAIL_USER}>`,
        to: EMAIL_TO,
        subject: "🚀 Puffer Oracle: Deployment Successful",
        text: `Your Oracle is now online and monitoring the Movement Network.\n\nServer URL: ${APP_URL}\nTime: ${new Date().toISOString()}`,
        html: `<h2>🚀 Deployment Successful</h2>
               <p>Your Oracle is now <b>Online</b> and monitoring the Movement Network.</p>
               <p><b>Server URL:</b> <a href="${APP_URL}">${APP_URL}</a></p>
               <p><b>Status:</b> ✅ Connected & Notarizing</p>
               <p><small>This is a one-time confirmation sent upon system startup.</small></p>`,
      });
      console.log("📧 Deployment confirmation email sent.");
    } catch (err) {
      console.error("❌ Failed to send deployment email:", err.message);
    }
  } else {
    console.log("ℹ️ Deployment email skipped (missing credentials).");
  }
});
