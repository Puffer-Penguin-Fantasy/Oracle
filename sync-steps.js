/**
 * Puffer Walks Background Synchronizer — Parallelized
 * -------------------------------------------------
 * Fetches steps concurrently with limited concurrency to avoid 429s.
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
  process.exit(1);
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

// ─── Individual Participant Sync ──────────────────────────────────────────────
async function syncParticipant({ wallet, tokenData, participantRef, dateObj, game }) {
  try {
    const accessToken = await getValidToken(wallet, tokenData);

    const fitbitRes = await axios.get(
      `https://api.fitbit.com/1/user/-/activities/tracker/steps/date/${dateObj.str}/1d.json`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 8000 }
    );
    const trackerSteps = fitbitRes.data?.['activities-tracker-steps'];
    if (!trackerSteps || trackerSteps.length === 0) return;
    const steps = parseInt(trackerSteps[0].value, 10);
    if (isNaN(steps)) return;

    const gameStartTime = new Date(game.startTime * 1000);
    gameStartTime.setUTCHours(0, 0, 0, 0);
    const targetDate = new Date(dateObj.str);
    targetDate.setUTCHours(0, 0, 0, 0);

    const dayIdx = Math.floor((targetDate - gameStartTime) / 86400000);
    if (dayIdx >= 0 && dayIdx < (game.numDays || 7)) {
      const dayKey = `day${dayIdx + 1}`;
      await participantRef.update({
        [`days.${dayKey}`]: steps,
        lastUpdated: new Date().toISOString(),
      });
      console.log(`  ✅ ${wallet.slice(0, 8)}… ${dateObj.label}: ${steps} steps → ${dayKey}`);
    }
  } catch (err) {
    const status = err.response?.status;
    console.error(`  ❌ ${wallet.slice(0, 8)}… [${status || 'ERR'}]: ${err.response?.data?.errors?.[0]?.message || err.message}`);
  }
}

// ─── Main Sync Loop ───────────────────────────────────────────────────────────
async function runSync() {
  console.log(`\n☁️ Puffer Parallel Sync Running: ${new Date().toISOString()}`);
  
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const datesToSync = [
    { str: yesterday.toISOString().split("T")[0], label: "yesterday" },
    { str: now.toISOString().split("T")[0], label: "today" }
  ];
  
  // 1. Pre-fetch all connected tokens to avoid N+1 queries
  console.log("📂 Pre-fetching connected Fitbit tokens...");
  const tokensSnap = await db.collection("fitbit_tokens")
    .where("connected", "==", true)
    .get();
  
  const tokenMap = new Map();
  tokensSnap.docs.forEach(doc => {
    tokenMap.set(doc.id.toLowerCase(), doc.data());
  });
  console.log(`✅ Loaded ${tokenMap.size} connected tokens.`);

  const gamesSnap = await db.collection("games").get();
  const tasks = [];

  for (const gameDoc of gamesSnap.docs) {
    const game = gameDoc.data();
    const startTime = game.startTime || 0;
    const numDays = game.numDays || 7;
    const endTimeSecs = game.endTime || (startTime + numDays * 86400);

    // Skip games that ended more than 48 hours ago
    if (now.getTime() / 1000 > (endTimeSecs + 172800)) continue;

    console.log(`🎮 Checking Game: ${game.name || gameDoc.id}`);
    const participantsSnap = await gameDoc.ref.collection("participants").get();
    
    for (const participantDoc of participantsSnap.docs) {
      const p = participantDoc.data();
      const wallet = p.walletAddress?.toLowerCase();
      if (!wallet) continue;

      // Use the pre-fetched map
      const tokenData = tokenMap.get(wallet);
      if (!tokenData) continue;

      for (const dateObj of datesToSync) {
        tasks.push(() => syncParticipant({
          wallet,
          tokenData,
          participantRef: participantDoc.ref,
          dateObj,
          game
        }));
      }
    }
  }

  console.log(`📋 Total fetch tasks: ${tasks.length} (running 30 at a time)`);
  await runWithConcurrency(tasks, 30);
}

runSync().then(() => {
  console.log("\n✅ Sync cycle complete.");
  process.exit(0);
}).catch(err => {
  console.error("Fatal sync error:", err);
  process.exit(1);
});
