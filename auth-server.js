/**
 * Puffer Walks Auth Server
 * -------------------------------------------------
 * Responsible for Fitbit OAuth2 flow & token management.
 * 
 * Features:
 *  - OAuth code exchange
 *  - Automated token refreshing (Fitbit tokens expire every 8 hours)
 *  - Step fetching via centralized backend
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");

// ─── Firebase Admin Init ─────────────────────────────────────────────────────
let serviceAccount;
try {
  let secret = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  secret = secret.replace(/[\n\r]/g, "").replace(/\s(?={)/, "");
  serviceAccount = JSON.parse(secret);
} catch (err) {
  console.error("❌ Firebase Secret Error in Auth Server:", err.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;
const FITBIT_CLIENT_ID = process.env.FITBIT_CLIENT_ID;
const FITBIT_CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET;
const FITBIT_REDIRECT_URI = process.env.FITBIT_REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// ─── Helper: Fitbit Token Refresh ─────────────────────────────────────────────
async function getValidToken(walletAddress) {
  const tokenRef = db.collection("fitbit_tokens").doc(walletAddress);
  const doc = await tokenRef.get();
  
  if (!doc.exists) throw new Error("No tokens found for user");
  const data = doc.data();
  
  // Check if token expires in less than 5 minutes
  const now = Date.now();
  const expiresAt = data.expiresAt || 0;
  
  if (now + 300000 < expiresAt) {
    return data.accessToken;
  }
  
  console.log(`🔄 Refreshing token for ${walletAddress}...`);
  
  const authHeader = Buffer.from(`${FITBIT_CLIENT_ID}:${FITBIT_CLIENT_SECRET}`).toString("base64");
  try {
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
      connected: true,
      lastRefreshed: new Date().toISOString()
    };
    
    await tokenRef.update(newTokens);
    return newTokens.accessToken;
  } catch (err) {
    console.error(`❌ Refresh failed for ${walletAddress}:`, err.response?.data || err.message);
    if (err.response?.status === 400 || err.response?.status === 401) {
      // Refresh token is revoked or invalid — user must reconnect
      await tokenRef.update({ connected: false });
    }
    throw new Error("Token refresh failed");
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// 1. Get OAuth URL
app.get("/auth/fitbit/url", (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: "Missing wallet" });
  
  const scope = "activity profile";
  const url = `https://www.fitbit.com/oauth2/authorize?response_type=code&client_id=${FITBIT_CLIENT_ID}&redirect_uri=${encodeURIComponent(FITBIT_REDIRECT_URI)}&scope=${scope}&state=${wallet}`;
  
  res.json({ url });
});

// 2. Callback handler (legacy redirect or direct landing)
app.get("/auth/fitbit/callback", async (req, res) => {
  const { code, state: wallet, error } = req.query;
  
  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}/?fitbit=denied`);
  }
  
  res.redirect(`${FRONTEND_URL}/callback?code=${code}&state=${wallet}`);
});

// 3. Exchange code for tokens
app.post("/auth/fitbit/exchange", async (req, res) => {
  const { code, walletAddress } = req.body;
  if (!code || !walletAddress) return res.status(400).json({ error: "Missing params" });
  
  const authHeader = Buffer.from(`${FITBIT_CLIENT_ID}:${FITBIT_CLIENT_SECRET}`).toString("base64");
  
  try {
    const response = await axios.post("https://api.fitbit.com/oauth2/token",
      `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(FITBIT_REDIRECT_URI)}`,
      {
        headers: {
          "Authorization": `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );
    
    const { access_token, refresh_token, expires_in, user_id } = response.data;
    
    await db.collection("fitbit_tokens").doc(walletAddress).set({
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + (expires_in * 1000),
      fitbitUserId: user_id,
      walletAddress: walletAddress,
      connected: true,
      lastUpdated: new Date().toISOString()
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Exchange Error:", err.response?.data || err.message);
    res.status(500).json({ error: "Exchange failed" });
  }
});

// 4. Fetch steps (with auto-refresh)
app.post("/auth/fitbit/steps", async (req, res) => {
  const { wallet, date } = req.body;
  if (!wallet || !date) return res.status(400).json({ error: "Missing params" });
  
  try {
    const accessToken = await getValidToken(wallet);
    
    const fitbitRes = await axios.get(
      `https://api.fitbit.com/1/user/-/activities/date/${date}.json`,
      { headers: { "Authorization": `Bearer ${accessToken}` } }
    );
    
    const steps = fitbitRes.data.summary.steps;
    res.json({ steps });
  } catch (err) {
    console.error(`❌ Steps fetch failed for ${wallet}:`, err.message);
    res.status(401).json({ error: "Authentication failed or token expired" });
  }
});

// 5. Disconnect
app.post("/auth/fitbit/disconnect", async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: "Missing wallet" });
  
  await db.collection("fitbit_tokens").doc(wallet).delete();
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Puffer Auth Server running at http://localhost:${PORT}`);
});
