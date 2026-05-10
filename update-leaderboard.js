/**
 * Puffer Walks Global Leaderboard Updater — De-duplicated
 * -------------------------------------------------------
 * Aggregates unique daily steps for all users across all games.
 * Prevents double-counting steps if a user is in multiple games 
 * occurring in the same timeframe.
 */

require("dotenv").config();
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
  console.error("❌ Firebase Secret Error:", err.message);
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

async function updateGlobalLeaderboard() {
  console.log(`\n🏆 Starting Global Leaderboard Update (De-duplicated): ${new Date().toISOString()}`);
  
  // Structure: Map<walletAddress, Map<dateString, maxSteps>>
  const userDailySteps = new Map();

  // 1. Fetch all games
  const gamesSnap = await db.collection("games").get();
  console.log(`🎮 Found ${gamesSnap.size} games to process.`);

  for (const gameDoc of gamesSnap.docs) {
    const game = gameDoc.data();
    const startTimeSeconds = game.startTime || 0;
    if (!startTimeSeconds) continue;

    const gameStartDate = new Date(startTimeSeconds * 1000);
    gameStartDate.setUTCHours(0, 0, 0, 0);

    // 2. Fetch all participants for each game
    const participantsSnap = await gameDoc.ref.collection("participants").get();
    
    for (const participantDoc of participantsSnap.docs) {
      const p = participantDoc.data();
      const wallet = p.walletAddress?.toLowerCase();
      if (!wallet) continue;

      const days = p.days || {};
      
      if (!userDailySteps.has(wallet)) {
        userDailySteps.set(wallet, new Map());
      }
      const dailyMap = userDailySteps.get(wallet);

      // Map day1, day2... to actual dates and store steps
      Object.entries(days).forEach(([dayKey, steps]) => {
        if (typeof steps !== 'number') return;

        const dayMatch = dayKey.match(/day(\d+)/);
        if (!dayMatch) return;

        const dayNum = parseInt(dayMatch[1]);
        const date = new Date(gameStartDate);
        date.setUTCDate(date.getUTCDate() + (dayNum - 1));
        const dateStr = date.toISOString().split('T')[0];

        // Store the maximum steps seen for this user on this date
        // (Ensures we don't count the same day twice if in multiple games)
        const currentMax = dailyMap.get(dateStr) || 0;
        if (steps > currentMax) {
          dailyMap.set(dateStr, steps);
        }
      });
    }
  }

  console.log(`👤 Found ${userDailySteps.size} unique users with daily data.`);

  // 3. Update the 'users' collection with summed unique steps
  const batchSize = 400;
  let batch = db.batch();
  let count = 0;
  let totalUpdated = 0;

  for (const [wallet, dailyMap] of userDailySteps.entries()) {
    let totalSteps = 0;
    dailyMap.forEach(steps => {
      totalSteps += steps;
    });

    const userRef = db.collection("users").doc(wallet);
    batch.set(userRef, { totalSteps, lastUpdated: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    
    count++;
    if (count >= batchSize) {
      await batch.commit();
      totalUpdated += count;
      console.log(`✨ Progress: Updated ${totalUpdated} users...`);
      batch = db.batch();
      count = 0;
    }
  }

  if (count > 0) {
    await batch.commit();
    totalUpdated += count;
  }

  console.log(`\n✅ De-duplicated Leaderboard Update Complete! Total users updated: ${totalUpdated}`);
}

updateGlobalLeaderboard().then(() => {
  process.exit(0);
}).catch(err => {
  console.error("Fatal update error:", err);
  process.exit(1);
});
