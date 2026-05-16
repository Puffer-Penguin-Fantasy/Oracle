/**
 * Puffer Walks Background Synchronizer — Optimized & User-Centric
 * --------------------------------------------------------------
 * Fetches steps for each unique user once per cycle and applies to all games.
 */
require("dotenv").config();
const axios = require("axios");
const admin = require("firebase-admin");

// ─── Firebase Admin Init ─────────────────────────────────────────────────────
let serviceAccount;
try {
  let secret = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  if (!secret) throw new Error("FIREBASE_SERVICE_ACCOUNT is empty!");
  if (secret.startsWith('"') && secret.endsWith('"')) {
    secret = secret.substring(1, secret.length - 1);
  }
  const cleanedSecret = secret.replace(/[\n\r]/g, "");
  serviceAccount = JSON.parse(cleanedSecret);
} catch (err) {
  console.error("❌ Firebase Secret Error in Sync Oracle:", err.message);
  if (require.main === module) process.exit(1);
  // If running as module, we don't exit; the error will be handled by the caller
}

if (!admin.apps.length) {
  if (serviceAccount && serviceAccount.private_key) {
    let pk = serviceAccount.private_key.replace(/\\n/g, '\n');
    const header = "-----BEGIN PRIVATE KEY-----";
    const footer = "-----END PRIVATE KEY-----";
    if (pk.includes(header) && pk.includes(footer)) {
      const parts = pk.split(header)[1].split(footer);
      const body = parts[0].replace(/[\s\n\r]/g, ""); 
      pk = `${header}\n${body}\n${footer}\n`;
    }
    serviceAccount.private_key = pk;
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

const FITBIT_CLIENT_ID = process.env.FITBIT_CLIENT_ID;
const FITBIT_CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET;

// ─── Helper: Fitbit Token Refresh ─────────────────────────────────────────────
async function getValidToken(walletAddress, data) {
  const now = Date.now();
  const expiresAt = data.expires_at || data.expiresAt || 0;
  const accessToken = data.access_token || data.accessToken;
  const refreshToken = data.refresh_token || data.refreshToken;
  
  if (now + 900000 < expiresAt && accessToken) {
    return accessToken;
  }
  
  if (!refreshToken) {
    throw new Error("No refresh token available");
  }

  const authHeader = Buffer.from(`${FITBIT_CLIENT_ID}:${FITBIT_CLIENT_SECRET}`).toString("base64");
  
  const res = await axios.post("https://api.fitbit.com/oauth2/token", 
    `grant_type=refresh_token&refresh_token=${refreshToken}`,
    {
      headers: {
        "Authorization": `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );
  
  const newTokens = {
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token,
    expires_at: Date.now() + (res.data.expires_in * 1000),
    lastRefreshed: new Date().toISOString()
  };
  
  await db.collection("fitbit_tokens").doc(walletAddress).update(newTokens);
  return newTokens.access_token;
}

// ─── Concurrency Limiter ──────────────────────────────────────────────────────
async function runWithConcurrency(tasks, limit = 10) {
  const results = [];
  let i = 0;
  async function runNext() {
    if (i >= tasks.length) return;
    const idx = i++;
    results[idx] = await tasks[idx]().catch(e => ({ error: e.message }));
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, runNext));
  return results;
}

// ─── Main Sync Loop ───────────────────────────────────────────────────────────
async function runSync() {
  console.log(`\n☁️ Puffer Optimized Sync Running: ${new Date().toISOString()}`);
  
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const datesToSync = [
    { str: yesterday.toISOString().split("T")[0], label: "yesterday" },
    { str: now.toISOString().split("T")[0], label: "today" }
  ];
  
  // 1. Pre-fetch all connected tokens
  console.log("📂 Pre-fetching connected Fitbit tokens...");
  const tokensSnap = await db.collection("fitbit_tokens")
    .where("connected", "==", true)
    .get();
  
  const tokenMap = new Map();
  tokensSnap.docs.forEach(doc => {
    tokenMap.set(doc.id.toLowerCase(), doc.data());
  });
  console.log(`✅ Loaded ${tokenMap.size} connected tokens.`);

  // 2. Build User -> Games Map
  console.log("🎮 Mapping users to active games...");
  const userToGames = new Map(); // Map<wallet, Array<{game, participantRef}>>
  const gamesSnap = await db.collection("games").get();

  for (const gameDoc of gamesSnap.docs) {
    const game = gameDoc.data();
    const startTime = game.startTime || 0;
    const numDays = game.numDays || 7;
    const endTimeSecs = game.endTime || (startTime + numDays * 86400);

    // Skip games that ended more than 48 hours ago
    if (now.getTime() / 1000 > (endTimeSecs + 172800)) continue;

    const participantsSnap = await gameDoc.ref.collection("participants").get();
    for (const participantDoc of participantsSnap.docs) {
      const p = participantDoc.data();
      const wallet = p.walletAddress?.toLowerCase();
      if (!wallet || !tokenMap.has(wallet)) continue;

      if (!userToGames.has(wallet)) userToGames.set(wallet, []);
      userToGames.get(wallet).push({ game, ref: participantDoc.ref });
    }
  }
  console.log(`✅ Found ${userToGames.size} unique users to sync across all active games.`);

  // 3. Create Fetch Tasks (One per unique user)
  const tasks = [];
  for (const [wallet, games] of userToGames.entries()) {
    tasks.push(async () => {
      try {
        const tokenData = tokenMap.get(wallet);
        const accessToken = await getValidToken(wallet, tokenData);

        for (const dateObj of datesToSync) {
          // One Fitbit request per date
          const fitbitRes = await axios.get(
            `https://api.fitbit.com/1/user/-/activities/tracker/steps/date/${dateObj.str}/1d.json`,
            { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 8000 }
          );

          const trackerSteps = fitbitRes.data?.['activities-tracker-steps'];
          if (!trackerSteps || trackerSteps.length === 0) continue;
          const steps = parseInt(trackerSteps[0].value, 10);
          if (isNaN(steps)) continue;

          // Apply to all games this user is in
          for (const item of games) {
            const gameStartTime = new Date(item.game.startTime * 1000);
            gameStartTime.setUTCHours(0, 0, 0, 0);
            const targetDate = new Date(dateObj.str);
            targetDate.setUTCHours(0, 0, 0, 0);

            const dayIdx = Math.floor((targetDate - gameStartTime) / 86400000);
            if (dayIdx >= 0 && dayIdx < (item.game.numDays || 7)) {
              const dayKey = `day${dayIdx + 1}`;
              await item.ref.update({
                [`days.${dayKey}`]: steps,
                lastUpdated: new Date().toISOString(),
              });
            }
          }
          console.log(`  ✅ ${wallet.slice(0, 8)}… ${dateObj.label}: ${steps} steps (Applied to ${games.length} games)`);
        }
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.errors?.[0]?.message || err.message;
        console.error(`  ❌ ${wallet.slice(0, 8)}… [${status || 'ERR'}]: ${msg}`);
      }
    });
  }

  console.log(`📋 Total unique user fetch tasks: ${tasks.length} (running 10 at a time)`);
  await runWithConcurrency(tasks, 10);
}

// Only run automatically if executed directly via 'node sync-steps.js'
if (require.main === module) {
  runSync()
    .then(() => {
      console.log("\n✅ Sync cycle complete.");
      process.exit(0);
    })
    .catch(err => {
      console.error("Fatal sync error:", err);
      process.exit(1);
    });
}

module.exports = { runSync };
