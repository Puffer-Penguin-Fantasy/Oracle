/**
 * Puffer Walks Oracle — Blockchain Notarizer
 * -------------------------------------------------
 * This leaner oracle is responsible ONLY for moving verified 
 * Firestore data (synced by players) onto the Movement Network.
 *
 * It no longer needs Fitbit credentials or OAuth handling.
 *
 * Roles:
 *   1. Read step counts from Firestore (synced by frontend).
 *   2. Identify "completed" days (past the current game clock).
 *   3. Record those finalized steps on-chain via record_daily_steps.
 *
 * Schedule with cron:
 *   0 * * * * /usr/bin/node /path/to/oracle/oracle.js
 *
 * Required .env:
 *   ORACLE_PRIVATE_KEY, MODULE_ADDRESS, MOVEMENT_NODE_URL,
 *   FIREBASE_SERVICE_ACCOUNT (JSON string)
 */

require("dotenv").config();
const { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey } = require("@aptos-labs/ts-sdk");
const admin = require("firebase-admin");

// ─── Firebase Admin Init ─────────────────────────────────────────────────────
let serviceAccount;
try {
  let secret = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  secret = secret.replace(/[\n\r]/g, "").replace(/\s(?={)/, "");
  if (!secret) throw new Error("FIREBASE_SERVICE_ACCOUNT is empty!");
  serviceAccount = JSON.parse(secret);
} catch (err) {
  console.error("❌ Firebase Secret Error:", err.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
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

// ─── Helper: Batch On-Chain Submission ──────────────────────────────────────────
async function finalizeBatchOnChain(userAddrs, gameId, dayIdx, stepsList) {
  if (userAddrs.length === 0) return true;
  try {
    const tx = await aptos.transaction.build.simple({
      sender: oracleAccount.accountAddress,
      data: {
        function: `${MODULE_ADDRESS}::game::batch_record_daily_steps`,
        functionArguments: [userAddrs, parseInt(gameId), dayIdx, stepsList],
      },
    });

    const committed = await aptos.signAndSubmitTransaction({
      signer: oracleAccount,
      transaction: tx,
    });

    await aptos.waitForTransaction({ transactionHash: committed.hash });
    console.log(`  ✅ Batch Success: Game ${gameId} Day ${dayIdx} (${userAddrs.length} users notarized)`);
    return true;
  } catch (err) {
    console.error(`  ❌ Batch Failure for Game ${gameId} Day ${dayIdx}:`, err.message);
    return false;
  }
}

// ─── Main Oracle Loop ─────────────────────────────────────────────────────────
async function runOracle() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  console.log(`\n🕐 Puffer Notarizer Running: ${new Date().toISOString()}`);

  const gamesSnap = await db.collection("games").get();
  if (gamesSnap.empty) return console.log("No games found.");

  for (const gameDoc of gamesSnap.docs) {
    const gameId = gameDoc.id;
    const gameData = gameDoc.data();
    const gameStartTime = gameData.startTime || 0;
    const numDays = gameData.numDays || 7;

    console.log(`\n🎮 Processing Game: ${gameData.name || gameId}`);

    // We process each game day one by one
    const currentDayIdx = Math.floor((nowSeconds - gameStartTime) / 86400);
    
    for (let d = 0; d < currentDayIdx && d < numDays; d++) {
      const dayKey = `day${d + 1}`;
      const chainKey = String(d);
      
      const batchAddrs = [];
      const batchSteps = [];
      const batchDocRefs = [];

      const participantsSnap = await gameDoc.ref.collection("participants").get();
      
      for (const participantDoc of participantsSnap.docs) {
        const p = participantDoc.data();
        const days = p.days || {};
        const daysOnChain = p.daysOnChain || {};

        if (daysOnChain[chainKey]) continue; // Already notarized

        const steps = days[dayKey];
        if (steps !== undefined && steps !== null) {
          batchAddrs.push(p.walletAddress);
          batchSteps.push(parseInt(steps));
          batchDocRefs.push(participantDoc.ref);
        }
      }

      if (batchAddrs.length > 0) {
        console.log(`  📝 Notarizing Day ${d + 1}: ${batchAddrs.length} users pending...`);
        const ok = await finalizeBatchOnChain(batchAddrs, gameId, d, batchSteps);
        if (ok) {
          // Mark all as finished in Firestore
          const batch = db.batch();
          batchDocRefs.forEach(ref => {
            batch.update(ref, { [`daysOnChain.${chainKey}`]: true });
          });
          await batch.commit();
        }
      }
    }
  }
  console.log("\n✅ Notarization cycle complete.");
}

runOracle().catch(err => {
  console.error("Fatal oracle error:", err);
  process.exit(1);
});
