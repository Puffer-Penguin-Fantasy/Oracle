/**
 * Puffer Walks Background Synchronizer
 * -------------------------------------------------
 * This script ensures that steps are fetched from Fitbit 
 * even if the player's browser is closed.
 * 
 * Schedule with cron:
 *   every 5 minutes: * /5 * * * * /usr/bin/node /path/to/oracle/sync-steps.js
 */
require("dotenv").config();
const axios = require("axios");
const admin = require("firebase-admin");

// ─── Firebase Admin Init ─────────────────────────────────────────────────────
let serviceAccount;
try {
  let secret = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  secret = secret.replace(/[\n\r]/g, "").replace(/\s(?={)/, "");
  serviceAccount = JSON.parse(secret);
} catch (err) {
  console.error("❌ Firebase Secret Error in Sync Oracle:", err.message);
  process.exit(1);
}

if (!admin.apps.length) {
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
  const expiresAt = data.expiresAt || 0;
  
  // If token is still valid for > 15 mins, return it
  if (now + 900000 < expiresAt && data.accessToken) {
    return data.accessToken;
  }
  
  console.log(`  🔄 Refreshing token for ${walletAddress}...`);
  const authHeader = Buffer.from(`${FITBIT_CLIENT_ID}:${FITBIT_CLIENT_SECRET}`).toString("base64");
  
  const res = await axios.post("https://api.fitbit.com/oauth2/token", 
    `grant_type=refresh_token&refresh_token=${data.refreshToken}`,
    {
      headers: {
        "Authorization": `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );
  
  const newTokens = {
    accessToken: res.data.access_token,
    refreshToken: res.data.refresh_token,
    expiresAt: Date.now() + (res.data.expires_in * 1000),
    lastRefreshed: new Date().toISOString()
  };
  
  await db.collection("fitbit_tokens").doc(walletAddress).update(newTokens);
  return newTokens.accessToken;
}

// ─── Main Sync Loop ───────────────────────────────────────────────────────────
async function runSync() {
  console.log(`\n☁️ Puffer Background Sync Running: ${new Date().toISOString()}`);
  
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];
  
  // 1. Get all active games
  const gamesSnap = await db.collection("games").get();
  
  for (const gameDoc of gamesSnap.docs) {
    const game = gameDoc.data();
    const gameId = gameDoc.id;
    
    // Skip ended games
    const endTime = game.endTime ? new Date(game.endTime * 1000) : null;
    if (endTime && now > endTime) continue;

    console.log(`🎮 Checking Game: ${game.name || gameId}`);
    
    const participantsSnap = await gameDoc.ref.collection("participants").get();
    
    for (const participantDoc of participantsSnap.docs) {
      const p = participantDoc.data();
      const wallet = p.walletAddress;
      
      if (!wallet) continue;
      
      // 2. Get user's Fitbit token
      const tokenSnap = await db.collection("fitbit_tokens").doc(wallet).get();
      if (!tokenSnap.exists || !tokenSnap.data().connected) {
        console.log(`  ⚠️ User ${wallet} is not connected to Fitbit.`);
        continue;
      }
      
      try {
        const tokenData = tokenSnap.data();
        const accessToken = await getValidToken(wallet, tokenData);
        
        // 3. Fetch steps for today
        const fitbitRes = await axios.get(
          `https://api.fitbit.com/1/user/-/activities/date/${todayStr}.json`,
          { headers: { "Authorization": `Bearer ${accessToken}` } }
        );
        
        const steps = fitbitRes.data.summary.steps;
        
        // 4. Update Firestore with new step count
        const gameStartTime = new Date(game.startTime * 1000);
        gameStartTime.setUTCHours(0,0,0,0);
        const todayMidnight = new Date();
        todayMidnight.setUTCHours(0,0,0,0);
        
        const diffTime = todayMidnight.getTime() - gameStartTime.getTime();
        const currentDayIdx = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        
        if (currentDayIdx >= 0 && currentDayIdx < (game.numDays || 7)) {
          const dayKey = `day${currentDayIdx + 1}`;
          await participantDoc.ref.update({
            [`days.${dayKey}`]: steps,
            lastUpdated: new Date().toISOString()
          });
          console.log(`  ✅ Synced ${steps} steps for ${wallet} (${dayKey})`);
        }
      } catch (err) {
        console.error(`  ❌ Failed to sync ${wallet}:`, err.response?.data || err.message);
      }
    }
  }
}

runSync().then(() => {
  console.log("\n✅ Sync cycle complete.");
  process.exit(0);
}).catch(err => {
  console.error("Fatal sync error:", err);
  process.exit(1);
});
