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
console.log(`📡 Connected to Firestore Project: ${serviceAccount.project_id}`);

// ─── Movement Client Init ─────────────────────────────────────────────────────
const aptosConfig = new AptosConfig({
  network: Network.CUSTOM,
  fullnode: process.env.MOVEMENT_NODE_URL || "https://mainnet.movementnetwork.xyz/v1",
});
const aptos = new Aptos(aptosConfig);
const MODULE_ADDRESS = process.env.MODULE_ADDRESS;

const oraclePrivateKey = new Ed25519PrivateKey(process.env.ORACLE_PRIVATE_KEY);
const oracleAccount = Account.fromPrivateKey({ privateKey: oraclePrivateKey });

console.log(`🔑 Oracle Address: ${oracleAccount.accountAddress.toString()}`);

// ─── Helper: Batch On-Chain Submission ──────────────────────────────────────────
async function finalizeBatchOnChain(userAddrs, gameId, dayIdx, stepsList) {
  if (userAddrs.length === 0) return true;
  try {
    const tx = await aptos.transaction.build.simple({
      sender: oracleAccount.accountAddress,
      data: {
        function: `${MODULE_ADDRESS}::game::batch_record_daily_steps`,
        functionArguments: [userAddrs, gameId.toString(), dayIdx.toString(), stepsList.map(s => s.toString())],
      },
    });

    const committed = await aptos.signAndSubmitTransaction({
      signer: oracleAccount,
      transaction: tx,
    });

    const result = await aptos.waitForTransaction({ transactionHash: committed.hash });
    if (!result.success) {
      // Record failure in Firestore to trigger cooldown
      await db.collection("games").doc(gameId).set({
        lastNotarizationFailure: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await sendEmailNotification(
        "🚨 Oracle Transaction FAILED",
        `Game: ${gameId}\nDay: ${dayIdx}\nError: ${result.vm_status}\nHash: ${committed.hash}`,
        `<h2>🚨 Notarization Failed</h2><p><b>Game:</b> ${gameId}</p><p><b>Day:</b> ${dayIdx}</p><p><b>Error:</b> ${result.vm_status}</p><p><b>Hash:</b> <a href="https://explorer.movementnetwork.xyz/txn/${committed.hash}">${committed.hash}</a></p>`
      );
      throw new Error(`Transaction failed: ${result.vm_status}`);
    }

    console.log(`  ✅ Batch Success! Hash: ${committed.hash}`);
    await sendEmailNotification(
      "✅ Oracle Batch SUCCESS",
      `Game: ${gameId}\nDay: ${dayIdx}\nUsers: ${userAddrs.length}\nHash: ${committed.hash}`,
      `<h2>✅ Notarization Successful</h2><p><b>Game:</b> ${gameId}</p><p><b>Day:</b> ${dayIdx}</p><p><b>Users:</b> ${userAddrs.length}</p><p><b>Hash:</b> <a href="https://explorer.movementnetwork.xyz/txn/${committed.hash}">${committed.hash}</a></p>`
    );
    return true;
  } catch (err) {
    console.error(`  ❌ Batch Failure for Game ${gameId} Day ${dayIdx}:`, err.message);
    return false;
  }
}

const { Resend } = require('resend');

async function sendEmailNotification(subject, text, html) {
  const { RESEND_API_KEY, EMAIL_TO } = process.env;
  
  if (!RESEND_API_KEY || !EMAIL_TO) {
    let missing = [];
    if (!RESEND_API_KEY) missing.push("RESEND_API_KEY");
    if (!EMAIL_TO) missing.push("EMAIL_TO");
    console.log(`    ℹ️ Email notifications skipped (missing: ${missing.join(", ")})`);
    return;
  }

  const resend = new Resend(RESEND_API_KEY);

  try {
    const { data, error } = await resend.emails.send({
      from: 'Puffer Oracle <onboarding@resend.dev>',
      to: EMAIL_TO,
      subject: subject,
      text: text,
      html: html,
    });
    
    if (error) {
      console.error("    ❌ Resend API Error:", error.message);
    } else {
      console.log("    📧 Email notification sent (via Resend).");
    }
  } catch (err) {
    console.error("    ❌ Failed to send email:", err.message);
  }
}

// --- NEW: Self-Healing Logic ---
async function syncMissingParticipantToFirestore(gameId, walletAddress, numDays) {
  try {
    const participantRef = db.collection("games").doc(gameId).collection("participants").doc(walletAddress.toLowerCase());
    const docSnap = await participantRef.get();
    
    if (!docSnap.exists) {
      console.log(`    ✅ Auto-syncing missing participant ${walletAddress} to Firestore...`);
      const initialDays = {};
      for (let i = 1; i <= numDays; i++) {
        initialDays[`day${i}`] = 0;
      }
      
      await participantRef.set({
        walletAddress: walletAddress.toLowerCase(),
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        days: initialDays,
        autoSynced: true // Mark as synced by Oracle
      }, { merge: true });
    }
  } catch (err) {
    console.error(`    ❌ Failed to auto-sync participant ${walletAddress}:`, err.message);
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
    const gameEndTime = gameData.endTime || (gameStartTime + numDays * 86400);

    // Skip games that ended more than 48 hours ago (172800 seconds)
    // This gives a window for the final syncs and notarization to complete.
    if (nowSeconds > (gameEndTime + 172800)) {
      continue;
    }

    console.log(`\n🎮 Processing Game: ${gameData.name || gameId}`);

    // --- NEW: Verify On-Chain Participants ---
    let onChainParticipants = [];
    try {
      const resource = await aptos.getAccountResource({
        accountAddress: MODULE_ADDRESS,
        resourceType: `${MODULE_ADDRESS}::game::GameStore`
      });
      const onChainGame = resource.games[parseInt(gameId)];
      if (onChainGame) {
        onChainParticipants = (onChainGame.participants || []).map(addr => addr.toLowerCase());
      }
    } catch (err) {
      console.error(`    ⚠️ Failed to fetch on-chain participants for game ${gameId}:`, err.message);
      // If we can't verify, we might want to skip or proceed with caution. 
      // Proceeding with Firestore only might lead back to the borrow error.
      continue; 
    }
    // -----------------------------------------

    // --- NEW: Anti-Spam Cooldown ---
    // If this game failed recently, skip it for 1 hour to prevent spamming
    const lastFailure = gameData.lastNotarizationFailure?.toDate?.() || new Date(0);
    const minutesSinceFailure = (Date.now() - lastFailure.getTime()) / (1000 * 60);
    if (minutesSinceFailure < 60) {
      console.log(`    ⏳ Skipping game ${gameId} (Failed ${Math.floor(minutesSinceFailure)}m ago, cooling down...)`);
      continue;
    }

    // We process each game day one by one.
    // Increasing Grace Period to 7 hours (25200s).
    // This gives players until 7 AM the next day to sync their steps before notarization.
    const GRACE_PERIOD = 25200; 
    const currentDayIdx = Math.floor((nowSeconds - gameStartTime - GRACE_PERIOD) / 86400);
    
    console.log(`  - Game Clock: Day ${Math.floor((nowSeconds - gameStartTime) / 86400) + 1}`);
    console.log(`  - Notarizable up to: Day ${currentDayIdx}`);

    for (let d = 0; d < currentDayIdx && d < numDays; d++) {
      const dayKey = `day${d + 1}`;
      const chainKey = String(d);
      
      const batchAddrs = [];
      const batchSteps = [];
      const batchDocRefs = [];

      const participantsSnap = await gameDoc.ref.collection("participants").get();
      console.log(`    (Found ${participantsSnap.size} participants in Firestore collection)`);
      
      // --- NEW: Self-Healing / Auto-Index ---
      // For each on-chain participant, ensure they exist in Firestore
      for (const onChainAddr of onChainParticipants) {
        await syncMissingParticipantToFirestore(gameId, onChainAddr, numDays);
      }
      
      for (const participantDoc of participantsSnap.docs) {
        const p = participantDoc.data();
        const pAddr = p.walletAddress?.toLowerCase();
        const days = p.days || {};
        const daysOnChain = p.daysOnChain || {};

        const steps = days[dayKey];
        const alreadyNotarized = !!daysOnChain[chainKey];
        const isJoinedOnChain = onChainParticipants.includes(pAddr);

        console.log(`      👤 ${pAddr?.slice(0,10)}... | ${dayKey}: ${steps ?? 'MISSING'} | onChain: ${alreadyNotarized} | joinedOnChain: ${isJoinedOnChain}`);

        if (alreadyNotarized || !isJoinedOnChain) continue;

        if (steps !== undefined && steps !== null) {
          batchAddrs.push(p.walletAddress);
          batchSteps.push(parseInt(steps));
          batchDocRefs.push(participantDoc.ref);
        }
      }

      if (batchAddrs.length > 0) {
        console.log(`  🚀 SENDING BATCH: Notarizing Day ${d + 1} for ${batchAddrs.length} users...`);
        
        // Chunk participants into groups of 50 to avoid blockchain transaction size limits
        const CHUNK_SIZE = 50;
        for (let i = 0; i < batchAddrs.length; i += CHUNK_SIZE) {
          const chunkAddrs = batchAddrs.slice(i, i + CHUNK_SIZE);
          const chunkSteps = batchSteps.slice(i, i + CHUNK_SIZE);
          const chunkRefs = batchDocRefs.slice(i, i + CHUNK_SIZE);

          console.log(`    - Processing chunk: users ${i + 1} to ${Math.min(i + CHUNK_SIZE, batchAddrs.length)}`);
          
          const ok = await finalizeBatchOnChain(chunkAddrs, gameId, d, chunkSteps);
          if (ok) {
            const firestoreBatch = db.batch();
            chunkRefs.forEach(ref => {
              firestoreBatch.update(ref, { [`daysOnChain.${chainKey}`]: true });
            });
            await firestoreBatch.commit();
            console.log(`    ✨ Chunk notarized and Firestore updated.`);
          }
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
