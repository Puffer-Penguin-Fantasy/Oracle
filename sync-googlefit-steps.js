/**
 * Puffer Walks Google Fit Background Synchronizer
 * -------------------------------------------------
 * Fetches steps concurrently from Google Fit API.
 */
require("dotenv").config();
const axios = require("axios");
const admin = require("firebase-admin");

// --- Firebase Admin Init ---
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
  console.error("❌ Firebase Secret Error in Google Fit Sync:", err.message);
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

const GOOGLE_CLIENT_ID = process.env.VITE_GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.VITE_GOOGLE_CLIENT_SECRET;

// --- Helper: Google Token Refresh ---
async function getValidToken(walletAddress, data) {
  const now = Date.now();
  const expiresAt = data.expires_at || 0;
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;

  // If token is still valid (with 5 min buffer), return it
  if (now + 300000 < expiresAt && accessToken) {
    return accessToken;
  }

  if (!refreshToken) {
    throw new Error("No refresh token available");
  }

  console.log(`  🔄 Refreshing Google token for ${walletAddress.slice(0, 8)}...`);

  try {
    const res = await axios.post("https://oauth2.googleapis.com/token", {
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    });

    const newTokens = {
      access_token: res.data.access_token,
      expires_at: Date.now() + (res.data.expires_in * 1000),
      lastRefreshed: new Date().toISOString()
    };

    await db.collection("googlefit_tokens").doc(walletAddress).update(newTokens);
    return newTokens.access_token;
  } catch (err) {
    console.error(`  ❌ Failed to refresh token for ${walletAddress}:`, err.response?.data || err.message);
    if (err.response?.data?.error === 'invalid_grant') {
      // Token was revoked
      await db.collection("googlefit_tokens").doc(walletAddress).update({ connected: false });
    }
    throw err;
  }
}

// --- Concurrency Limiter ---
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

// --- Individual Participant Sync ---
async function syncParticipant({ wallet, tokenData, participantRef, dateObj, game }) {
  try {
    const accessToken = await getValidToken(wallet, tokenData);

    const startTime = new Date(dateObj.str + "T00:00:00Z").getTime();
    const endTime = new Date(dateObj.str + "T23:59:59Z").getTime();

    const res = await axios.post(
      'https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate',
      {
        aggregateBy: [{ dataTypeName: "com.google.step_count.delta" }],
        bucketByTime: { durationMillis: endTime - startTime },
        startTimeMillis: startTime,
        endTimeMillis: endTime
      },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000
      }
    );

    let steps = 0;
    if (res.data.bucket && res.data.bucket[0]) {
      res.data.bucket[0].dataset.forEach(d => {
        d.point.forEach(p => {
          p.value.forEach(v => {
            steps += v.intVal || 0;
          });
        });
      });
    }

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
      console.log(`  ✅ GoogleFit: ${wallet.slice(0, 8)}… ${dateObj.label}: ${steps} steps → ${dayKey}`);
    }
  } catch (err) {
    console.error(`  ❌ GoogleFit: ${wallet.slice(0, 8)}… Error: ${err.message}`);
  }
}

// --- Main Sync Loop ---
async function runSync() {
  console.log(`\n☁️ Puffer Google Fit Sync Running: ${new Date().toISOString()}`);

  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const datesToSync = [
    { str: yesterday.toISOString().split("T")[0], label: "yesterday" },
    { str: now.toISOString().split("T")[0], label: "today" }
  ];

  // 1. Fetch ALL tokens once to avoid N+1 queries
  console.log("🎟️ Pre-fetching all Google Fit tokens...");
  const tokensSnap = await db.collection("googlefit_tokens").where("connected", "==", true).get();
  const tokenMap = new Map();
  tokensSnap.forEach(doc => {
    tokenMap.set(doc.id.toLowerCase(), doc.data());
  });
  console.log(`✅ Loaded ${tokenMap.size} connected tokens.`);

  const gamesSnap = await db.collection("games").get();
  const tasks = [];

  for (const gameDoc of gamesSnap.docs) {
    const game = gameDoc.data();
    const endTime = game.endTime ? new Date(game.endTime * 1000) : null;
    if (endTime && now.getTime() > (endTime.getTime() + 86400000)) continue;

    console.log(`🎮 Checking Game: ${game.name || gameDoc.id}`);
    const participantsSnap = await gameDoc.ref.collection("participants").get();

    for (const participantDoc of participantsSnap.docs) {
      const p = participantDoc.data();
      const wallet = p.walletAddress?.toLowerCase();
      if (!wallet) continue;

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

  console.log(`📋 Total fetch tasks: ${tasks.length} (running 20 at a time)`);
  await runWithConcurrency(tasks, 20);
}

runSync().then(() => {
  console.log("\n✅ Google Fit Sync complete.");
  process.exit(0);
}).catch(err => {
  console.error("Fatal sync error:", err);
  process.exit(1);
});
