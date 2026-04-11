const express = require('express');
const { exec } = require('child_process');
const app = express();
const port = process.env.PORT || 3000;

// Security: You can add a secret key later if you want
app.get('/sync', (req, res) => {
  console.log(`\n🔔 Sync Chain Triggered at ${new Date().toISOString()}`);
  
  // 1. Run sync-steps FIRST
  exec('node sync-steps.js', (err, stdout, stderr) => {
    if (err) {
      console.error(`❌ Sync Steps Error: ${err.message}`);
      return res.status(500).send(`Sync Failed: ${err.message}`);
    }
    if (stdout) console.log(`📋 Sync Output: ${stdout}`);

    // 2. Run notarizer (oracle.js) ONLY AFTER sync-steps is done
    console.log("🔗 Sync complete. Starting Notarization...");
    exec('node oracle.js', (err, stdout, stderr) => {
      if (err) console.error(`❌ Notarizer Error: ${err.message}`);
      if (stdout) console.log(`📋 Notarizer Output: ${stdout}`);
    });

    res.send('Sync complete. Notarization process started in background.');
  });
});

// Health check for Render
app.get('/', (req, res) => {
  res.send('Puffer Oracle is Live 🏃‍♂️');
});

app.listen(port, () => {
  console.log(`🚀 Oracle Web Server listening at http://localhost:${port}`);
});
