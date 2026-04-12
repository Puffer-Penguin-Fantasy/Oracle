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
  if (!secret) throw new Error("FIREBASE_SERVICE_ACCOUNT is empty!");
  
  // If the secret is double-quoted, strip outer quotes
  if (secret.startsWith('"') && secret.endsWith('"')) {
    secret = secret.substring(1, secret.length - 1);
  }

  // Remove actual newlines/returns from the JSON string to allow parsing if it was pasted as a formatted block
  const cleanedSecret = secret.replace(/[\n\r]/g, "");
  serviceAccount = JSON.parse(cleanedSecret);
} catch (err) {
  console.error("❌ Firebase Secret Error:", err.message);
  process.exit(1);
}

if (!admin.apps.length) {
  // Fix for Render/Vercel/Heroku where newlines in private keys are often escaped as \n
  if (serviceAccount && serviceAccount.private_key) {
    let pk = serviceAccount.private_key.replace(/\\n/g, '\n');
    
    // Ultimate PEM Cleaner: Remove all middle whitespace and ensure proper header/footer separation
    const header = "-----BEGIN PRIVATE KEY-----";
    const footer = "-----END PRIVATE KEY-----";
    if (pk.includes(header) && pk.includes(footer)) {
      const parts = pk.split(header)[1].split(footer);
      const body = parts[0].replace(/[\s\n\r]/g, ""); // Remove all formatting junk from base64
      pk = `${header}\n${body}\n${footer}\n`;
    }
    
    serviceAccount.private_key = pk;
  }
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
    // We add a 12-hour grace period (43200 seconds) before considering a day "finished".
    // This allows players to wake up the next morning and sync their watches before steps are locked on-chain.
    const GRACE_PERIOD = 43200; 
    const currentDayIdx = Math.floor((nowSeconds - gameStartTime - GRACE_PERIOD) / 86400);
    
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
