const express = require('express');
const { exec } = require('child_process');
const app = express();
const port = process.env.PORT || 3000;

// Optional: protect with a secret so random people can't trigger it
const SYNC_SECRET = process.env.SYNC_SECRET || null;

app.get('/sync', (req, res) => {
  if (SYNC_SECRET && req.query.secret !== SYNC_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  console.log(`\n🔔 Sync triggered: ${new Date().toISOString()}`);

  // Respond immediately so cron-job.org doesn't time out waiting
  res.send('Sync started.');

  // Run sync-steps ONLY. Oracle runs on its own GitHub Actions schedule.
  exec('node sync-steps.js', { timeout: 110000 }, (err, stdout, stderr) => {
    if (err) console.error(`❌ Sync error: ${err.message}`);
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    console.log('✅ Sync cycle done.');
  });
});

// Health check for Render
app.get('/', (req, res) => {
  res.send('Puffer Oracle is Live 🏃‍♂️');
});

app.listen(port, () => {
  console.log(`🚀 Oracle Web Server listening at http://localhost:${port}`);
});
