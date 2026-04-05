/**
 * Puffer Walks Oracle — Hourly
 * -------------------------------------------------
 * Runs EVERY HOUR to:
 *   1. Fetch Fitbit steps for every active game participant
 *   2. Update Firestore (days.dayN) with the LATEST step count (live, overwrites)
 *
 * Runs ONCE PER COMPLETED DAY to:
 *   3. Finalize the previous day on-chain via record_daily_steps
 *      (contract allows only one submission per day per user)
 *
 * Two-layer approach:
 *   FIRESTORE  → updated every hour  → powers the live leaderboard
 *   ON-CHAIN   → finalized once/day  → the source of truth for rewards
 *
 * Schedule with cron (every hour):
 *   0 * * * * /usr/bin/node /path/to/oracle/oracle.js >> /var/log/puffer-oracle.log 2>&1
 *
 * Required .env variables:
 *   ORACLE_PRIVATE_KEY, MODULE_ADDRESS, MOVEMENT_NODE_URL,
 *   FIREBASE_SERVICE_ACCOUNT (JSON string), FITBIT_CLIENT_ID, FITBIT_CLIENT_SECRET
 */

require("dotenv").config();
const { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey } = require("@aptos-labs/ts-sdk");
const admin = require("firebase-admin");
const axios = require("axios");

// ─── Firebase Admin Init ─────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://puffer-walks-default-rtdb.firebaseio.com",
  });
}
const db = admin.firestore();

// ─── Movement Client Init ─────────────────────────────────────────────────────
const aptosConfig = new AptosConfig({
  network: Network.CUSTOM,
  fullnode: process.env.MOVEMENT_NODE_URL || "https://testnet.movementnetwork.xyz/v1",
});
const aptos = new Aptos(aptosConfig);
const MODULE_ADDRESS = process.env.MODULE_ADDRESS;

const oraclePrivateKey = new Ed25519PrivateKey(process.env.ORACLE_PRIVATE_KEY);
const oracleAccount = Account.fromPrivateKey({ privateKey: oraclePrivateKey });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Refresh a user's Fitbit access token using their stored refresh token.
 */
async function refreshFitbitToken(refreshToken) {
  const credentials = Buffer.from(
    `${process.env.FITBIT_CLIENT_ID}:${process.env.FITBIT_CLIENT_SECRET}`
  ).toString("base64");

  const res = await axios.post(
    "https://api.fitbit.com/oauth2/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return res.data; // { access_token, refresh_token, ... }
}

/**
 * Fetch step count from Fitbit for a specific date (YYYY-MM-DD).
 */
async function getFitbitSteps(accessToken, date) {
  const res = await axios.get(
    `https://api.fitbit.com/1/user/-/activities/steps/date/${date}/1d.json`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const summary = res.data?.["activities-steps"]?.[0];
  return summary ? parseInt(summary.value, 10) : 0;
}

/**
 * Finalize a completed day on-chain via record_daily_steps.
 * Only called once per day — the contract rejects duplicate submissions.
 */
async function finalizeStepsOnChain(userAddress, gameId, dayIdx, steps) {
  try {
    const tx = await aptos.transaction.build.simple({
      sender: oracleAccount.accountAddress,
      data: {
        function: `${MODULE_ADDRESS}::game::record_daily_steps`,
        functionArguments: [userAddress, parseInt(gameId), dayIdx, steps],
      },
    });

    const committed = await aptos.signAndSubmitTransaction({
      signer: oracleAccount,
      transaction: tx,
    });

    await aptos.waitForTransaction({ transactionHash: committed.hash });
    console.log(`  ✅ On-chain finalized: ${userAddress} game=${gameId} day=${dayIdx} steps=${steps}`);
    return true;
  } catch (err) {
    console.error(`  ❌ On-chain failed for ${userAddress} day=${dayIdx}:`, err.message);
    return false;
  }
}

// ─── Main Oracle Loop ─────────────────────────────────────────────────────────

async function runOracle() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const todayDate = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  console.log(`\n🕐 Puffer Oracle (hourly) running at: ${new Date().toISOString()}`);

  // Fetch all games from Firestore
  const gamesSnap = await db.collection("games").get();
  if (gamesSnap.empty) {
    console.log("No games in Firestore. Exiting.");
    return;
  }

  for (const gameDoc of gamesSnap.docs) {
    const gameId = gameDoc.id;
    console.log(`\n🎮 Game: ${gameId}`);

    const participantsSnap = await db
      .collection("games")
      .doc(gameId)
      .collection("participants")
      .get();

    if (participantsSnap.empty) {
      console.log("  No participants yet.");
      continue;
    }

    for (const participantDoc of participantsSnap.docs) {
      const p = participantDoc.data();
      const walletAddress = p.walletAddress;
      const gameStartTime = p.gameStartTime || 0;  // stored at join time
      const gameEndTime   = p.gameEndTime   || 0;
      const numDays       = p.numDays       || 7;
      const days          = p.days          || {};
      const daysOnChain   = p.daysOnChain   || {}; // { "0": true, "1": true, ... }

      // ── Guard: game not started yet ───────────────────────────────────────
      if (nowSeconds < gameStartTime) {
        console.log(`  ⏳ ${walletAddress} — game hasn't started yet`);
        continue;
      }

      // ── Compute current game day (0-indexed) ──────────────────────────────
      const currentDayIdx = Math.floor((nowSeconds - gameStartTime) / 86400);

      // Game fully ended — only finalize any remaining on-chain days
      if (currentDayIdx >= numDays) {
        console.log(`  🏁 ${walletAddress} — game ended, checking on-chain finalizations`);
        await finalizeCompletedDays({
          walletAddress, gameId, numDays, days, daysOnChain, participantDoc
        });
        continue;
      }

      // ── Step 1: Fetch Fitbit steps for TODAY ──────────────────────────────
      let todaySteps = 0;
      try {
        const userDoc = await db.collection("users").doc(walletAddress).get();
        const userData = userDoc.exists ? userDoc.data() : null;

        if (!userData?.fitbitRefreshToken) {
          console.log(`  ⚠️  No Fitbit token for ${walletAddress}`);
        } else {
          const tokens = await refreshFitbitToken(userData.fitbitRefreshToken);
          // Persist refreshed token
          await db.collection("users").doc(walletAddress).update({
            fitbitAccessToken: tokens.access_token,
            fitbitRefreshToken: tokens.refresh_token,
          });
          todaySteps = await getFitbitSteps(tokens.access_token, todayDate);
          console.log(`  📊 ${walletAddress} — Day ${currentDayIdx + 1} live steps: ${todaySteps}`);
        }
      } catch (err) {
        console.error(`  ❌ Fitbit fetch failed for ${walletAddress}:`, err.message);
      }

      // ── Step 2: Update Firestore with live hourly step count ───────────────
      // This overwrites the current day's value every hour so the
      // leaderboard always shows up-to-date progress.
      const currentDayKey = `day${currentDayIdx + 1}`;
      await db
        .collection("games")
        .doc(gameId)
        .collection("participants")
        .doc(walletAddress)
        .update({
          [`days.${currentDayKey}`]: todaySteps,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        });

      // ── Step 3: Finalize any COMPLETED days on-chain (if not yet done) ────
      // A day is "completed" once we're past it (currentDayIdx > that day).
      // We only submit to the contract once — daysOnChain tracks this.
      await finalizeCompletedDays({
        walletAddress, gameId, numDays, currentDayIdx,
        days: { ...days, [currentDayKey]: todaySteps }, // include latest write
        daysOnChain, participantDoc
      });

      // Small delay between users to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log("\n✅ Hourly oracle run complete.");
}

/**
 * For each completed game day (< currentDayIdx) that hasn't been
 * submitted on-chain yet, finalize it now and mark it in Firestore.
 */
async function finalizeCompletedDays({
  walletAddress, gameId, numDays, currentDayIdx = numDays,
  days, daysOnChain, participantDoc
}) {
  for (let d = 0; d < currentDayIdx && d < numDays; d++) {
    const chainKey = String(d); // "0", "1", ... matches daysOnChain map
    if (daysOnChain[chainKey]) {
      continue; // already finalized
    }

    const dayKey = `day${d + 1}`;
    const steps  = days[dayKey];

    if (steps === null || steps === undefined) {
      // No steps recorded yet — skip (will retry next hour)
      console.log(`  ⏭️  ${walletAddress} day=${d} — no steps to finalize yet`);
      continue;
    }

    console.log(`  📝 Finalizing on-chain: ${walletAddress} day=${d} steps=${steps}`);
    const ok = await finalizeStepsOnChain(walletAddress, gameId, d, steps);

    if (ok) {
      // Mark this day as finalized so we never submit it again
      await participantDoc.ref.update({
        [`daysOnChain.${chainKey}`]: true,
      });
    }

    await new Promise(r => setTimeout(r, 300));
  }
}

// ─── Run (One-Shot for GitHub Actions) ────────────────────────────────────────
runOracle().catch(err => {
  console.error("Fatal oracle error:", err);
  process.exit(1);
});
