const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');
const { Resend } = require('resend');
require('dotenv').config();
const app = express();
const port = process.env.PORT || 3000;

// Optional: protect with a secret
const SYNC_SECRET = process.env.SYNC_SECRET || null;

const { runSync } = require('./sync-steps');
const { runOracle } = require('./oracle');
const { updateGlobalLeaderboard } = require('./update-leaderboard');

// ENDPOINT 1: Sync Fitbit data (Run every 2 mins)
app.get('/sync', async (req, res) => {
  if (SYNC_SECRET && req.query.secret !== SYNC_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  console.log(`\n🔔 Fitbit Sync triggered: ${new Date().toISOString()}`);
  res.send('Fitbit sync started.');

  try {
    await runSync();
    console.log('🏁 Fitbit Sync complete.');
  } catch (err) {
    console.error(`❌ runSync error: ${err.message}`);
  }
});

// ENDPOINT 2: Blockchain Notarization (Run every 3 hours)
app.get('/notarize', async (req, res) => {
  if (SYNC_SECRET && req.query.secret !== SYNC_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  console.log(`\n🚀 Blockchain Notarization triggered: ${new Date().toISOString()}`);
  res.send('Notarization started.');

  try {
    await runOracle();
    console.log('✅ Notarization complete. Updating Global Leaderboard...');
    await updateGlobalLeaderboard();
    console.log('🏁 Full Notarization cycle done.');
  } catch (err) {
    console.error(`❌ Notarization/Leaderboard error: ${err.message}`);
  }
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
}, 14 * 60 * 1000);

app.listen(port, async () => {
  console.log(`🚀 Oracle Web Server listening at http://localhost:${port}`);
  console.log(`📡 Keep-alive active for: ${APP_URL}`);

  // --- Send Deployment Confirmation Email ---
  const { RESEND_API_KEY, EMAIL_TO } = process.env;
  if (RESEND_API_KEY && EMAIL_TO) {
    const resend = new Resend(RESEND_API_KEY);

    try {
      const { data, error } = await resend.emails.send({
        from: 'Puffer Oracle <onboarding@resend.dev>',
        to: EMAIL_TO,
        subject: "🚀 Puffer Oracle: Deployment Successful",
        text: `Your Oracle is now online and monitoring the Movement Network.\n\nServer URL: ${APP_URL}\nTime: ${new Date().toISOString()}`,
        html: `<h2>🚀 Deployment Successful</h2>
               <p>Your Oracle is now <b>Online</b> and monitoring the Movement Network.</p>
               <p><b>Server URL:</b> <a href="${APP_URL}">${APP_URL}</a></p>
               <p><b>Status:</b> ✅ Connected & Notarizing</p>
               <p><small>This is a one-time confirmation sent upon system startup via Resend.</small></p>`,
      });
      
      if (error) {
        console.error("❌ Resend API Error:", error.message);
      } else {
        console.log("📧 Deployment confirmation email sent (via Resend).");
      }
    } catch (err) {
      console.error("❌ Failed to send deployment email:", err.message);
    }
  } else {
    console.log("ℹ️ Deployment email skipped (missing RESEND_API_KEY or EMAIL_TO).");
  }
});
