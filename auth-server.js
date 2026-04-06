/**
 * Puffer Walks — Fitbit Auth Server
 * -------------------------------------------------------
 * Handles the OAuth 2.0 Authorization Code + PKCE flow for Fitbit.
 * Stores refresh tokens in Firestore against the user's wallet address.
 * The oracle then uses these tokens to pull step data on their behalf.
 *
 * Endpoints:
 *   GET /auth/fitbit/url?wallet=0x...   → Returns the Fitbit OAuth URL
 *   GET /auth/fitbit/callback?code=...&wallet=0x...  → Exchanges code for tokens, stores in Firestore
 *   POST /auth/fitbit/refresh           → Refreshes an expired access token (used by oracle)
 *   GET /auth/fitbit/status?wallet=0x... → Returns connection status
 *
 * Run: node auth-server.js
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// ─── Firebase Admin Init ───────────────────────────────────────────────────────
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
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// ─── Helper: Standardize Wallet Address ────────────────────────────────────────
function standardizeAddress(addr) {
  if (!addr) return null;
  let clean = addr.toLowerCase().trim();
  if (!clean.startsWith("0x")) clean = "0x" + clean;
  // Ensure Aptos addresses are at least reasonably long or standard
  return clean;
}
const CLIENT_ID = process.env.FITBIT_CLIENT_ID;
const CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET;
const REDIRECT_URI = process.env.FITBIT_REDIRECT_URI || "http://localhost:3001/auth/fitbit/callback";
const SCOPES = "activity profile";
const PORT = process.env.AUTH_PORT || 3001;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ FITBIT_CLIENT_ID and FITBIT_CLIENT_SECRET must be set in .env");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── Helper: Exchange code for tokens ────────────────────────────────────────
async function exchangeCode(code) {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://api.fitbit.com/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }
  return res.json();
}

// ─── Helper: Refresh access token ────────────────────────────────────────────
async function refreshAccessToken(walletAddress) {
  const userDoc = await db.collection("fitbit_tokens").doc(walletAddress.toLowerCase()).get();
  if (!userDoc.exists) throw new Error("No token found for wallet");

  const { refresh_token } = userDoc.data();
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://api.fitbit.com/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    // If refresh fails (revoked), mark as disconnected in Firestore  
    await db.collection("fitbit_tokens").doc(walletAddress.toLowerCase()).update({
      connected: false,
      error: err,
    });
    throw new Error(`Token refresh failed: ${err}`);
  }

  const tokens = await res.json();

  // Save the new tokens (Fitbit rotates refresh tokens each use)
  await db.collection("fitbit_tokens").doc(walletAddress.toLowerCase()).set({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    fitbit_user_id: tokens.user_id,
    connected: true,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return tokens.access_token;
}

// ─── GET /auth/fitbit/url ─────────────────────────────────────────────────────
// Returns the Fitbit OAuth URL for the frontend to redirect to
app.get("/auth/fitbit/url", (req, res) => {
  const wallet = standardizeAddress(req.query.wallet);
  if (!wallet) return res.status(400).json({ error: "wallet required" });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    prompt: "login consent",      // Force the consent screen even if already authorized
    state: wallet,                // Original standardized address through OAuth state
    expires_in: "604800",         // Request 1 week token lifetime
  });

  const url = `https://www.fitbit.com/oauth2/authorize?${params.toString()}`;
  console.log(`🔗 Generated Fitbit URL for wallet ${wallet}:`, url);
  res.json({ url });
});

// ─── POST /auth/fitbit/exchange ──────────────────────────────────────────────
// Frontend Callback page receives the code from Fitbit and POSTs it here.
// We exchange it for access + refresh tokens and store in Firestore.
app.post("/auth/fitbit/exchange", async (req, res) => {
  const { code, walletAddress } = req.body;

  if (!code || !walletAddress) {
    return res.status(400).json({ error: "Missing code or walletAddress" });
  }

  try {
    const tokens = await exchangeCode(code);

    // Store tokens in Firestore — keyed by lowercase wallet address
    await db.collection("fitbit_tokens").doc(walletAddress.toLowerCase()).set({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
      fitbit_user_id: tokens.user_id,
      connected: true,
      connected_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Fitbit tokens stored for wallet: ${walletAddress}`);
    res.json({ success: true, fitbit_user_id: tokens.user_id });
  } catch (err) {
    console.error("❌ Exchange error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /auth/fitbit/callback (Server-side redirect handler) ────────────────
// This is used if the Fitbit App is configured with this server URL.
// It exchanges the code directly and then redirects to the frontend.
app.get("/auth/fitbit/callback", async (req, res) => {
  const { code, state } = req.query;
  const walletAddress = standardizeAddress(state);

  if (!code || !walletAddress) {
    console.warn("⚠️ Callback missing code or state (wallet)");
    return res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/?fitbit=error`);
  }

  try {
    console.log(`📥 Callback received for standardized wallet: ${walletAddress}`);
    const tokens = await exchangeCode(code);

    // Store tokens in Firestore
    await db.collection("fitbit_tokens").doc(walletAddress).set({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
      fitbit_user_id: tokens.user_id,
      connected: true,
      connected_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });

    console.log(`✅ Fitbit connection successful via server callback for: ${walletAddress}`);
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/?fitbit=connected`);
  } catch (err) {
    console.error("❌ Callback handling error:", err.message);
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/?fitbit=error`);
  }
});

// ─── GET /auth/fitbit/status ──────────────────────────────────────────────────
// Frontend polls this to check connection status
app.get("/auth/fitbit/status", async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: "wallet required" });

  try {
    const doc = await db.collection("fitbit_tokens").doc(wallet.toLowerCase()).get();
    if (!doc.exists || !doc.data().connected) {
      return res.json({ connected: false });
    }
    return res.json({ connected: true, fitbit_user_id: doc.data().fitbit_user_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /auth/fitbit/steps ──────────────────────────────────────────────────
// Called by frontend to fetch steps for a given date (auto-refreshes token)
app.post("/auth/fitbit/steps", async (req, res) => {
  const { wallet, date } = req.body;
  if (!wallet || !date) return res.status(400).json({ error: "wallet and date required" });

  try {
    // Get tokens from Firestore
    const doc = await db.collection("fitbit_tokens").doc(wallet.toLowerCase()).get();
    if (!doc.exists || !doc.data().connected) {
      return res.status(401).json({ error: "Not connected" });
    }

    let { access_token, expires_at } = doc.data();

    // Auto-refresh if token is expired or expiring within 5 minutes
    if (Date.now() > expires_at - 300000) {
      console.log(`🔄 Refreshing token for ${wallet}`);
      access_token = await refreshAccessToken(wallet);
    }

    // Fetch steps from Fitbit
    const fitbitRes = await fetch(`https://api.fitbit.com/1/user/-/activities/date/${date}.json`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!fitbitRes.ok) {
      if (fitbitRes.status === 401) {
        // Token was revoked — try one refresh
        try {
          access_token = await refreshAccessToken(wallet);
          const retryRes = await fetch(`https://api.fitbit.com/1/user/-/activities/date/${date}.json`, {
            headers: { Authorization: `Bearer ${access_token}` },
          });
          if (!retryRes.ok) throw new Error("Retry failed");
          const retryData = await retryRes.json();
          return res.json({ steps: retryData?.summary?.steps ?? 0 });
        } catch {
          await db.collection("fitbit_tokens").doc(wallet.toLowerCase()).update({ connected: false });
          return res.status(401).json({ error: "Token revoked, please reconnect Fitbit" });
        }
      }
      throw new Error(`Fitbit API error: ${fitbitRes.status}`);
    }

    const data = await fitbitRes.json();
    const steps = data?.summary?.steps ?? 0;
    res.json({ steps });
  } catch (err) {
    console.error("Step fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /auth/fitbit/disconnect ────────────────────────────────────────────
app.post("/auth/fitbit/disconnect", async (req, res) => {
  const wallet = standardizeAddress(req.body.wallet);
  if (!wallet) return res.status(400).json({ error: "wallet required" });

  await db.collection("fitbit_tokens").doc(wallet).set({ connected: false }, { merge: true });
  console.log(`📴 Fitbit disconnected for wallet: ${wallet}`);
  res.json({ success: true });
});

// ─── Export for Vercel / Local Listen ──────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Fitbit Auth Server running on port ${PORT}`);
  });
}

module.exports = app;
