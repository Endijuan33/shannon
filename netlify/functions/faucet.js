const { ethers } = require("ethers");
const { MongoClient } = require("mongodb");

const NETWORKS = [
  { name: 'Ethereum', rpc: process.env.ETH_RPC_URL },
  { name: 'Base', rpc: process.env.BASE_RPC_URL },
  { name: 'Polygon', rpc: process.env.POLYGON_RPC_URL },
  { name: 'Arbitrum', rpc: process.env.ARBITRUM_RPC_URL },
  { name: 'Linea', rpc: process.env.LINEA_RPC_URL },
  { name: 'Optimism', rpc: process.env.OPTIMISM_RPC_URL },
];

let cachedDb = null;
async function connectToDatabase() {
  if (cachedDb) {
    return cachedDb;
  }
  const client = await MongoClient.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  cachedDb = client.db(process.env.MONGO_DB);
  return cachedDb;
}

async function checkCooldown(type, value, now) {
  const db = await connectToDatabase();
  const collection = db.collection("claims");
  const doc = await collection.findOne({ type, value });
  if (doc && now - doc.lastClaim < 86400) {
    return doc.lastClaim;
  }
  return null;
}

async function updateCooldown(type, value, now) {
  const db = await connectToDatabase();
  const collection = db.collection("claims");
  await collection.updateOne(
    { type, value },
    { $set: { lastClaim: now } },
    { upsert: true }
  );
}

async function verifyCaptcha(captchaToken, remoteIp) {
  const secret = process.env.CF_CAPTCHA_SECRET;
  if (!captchaToken) {
    throw new Error("Missing captcha token");
  }
  const formData = new URLSearchParams();
  formData.append("secret", secret);
  formData.append("response", captchaToken);
  if (remoteIp) {
    formData.append("remoteip", remoteIp);
  }
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString()
  });
  const data = await response.json();
  return data.success;
}

async function isActiveAddress(address) {
  for (const net of NETWORKS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(net.rpc);
      const txCount = await provider.getTransactionCount(address);
      if (txCount > 0) {
        console.log(`Address ${address} is active on ${net.name}`);
        return true;
      }
    } catch (error) {
      console.error(`Error checking network ${net.name}:`, error);
    }
  }
  return false;
}

async function sendSTT(toAddress) {
  const provider = new ethers.providers.JsonRpcProvider(process.env.SOMNIA_TESTNET_RPC_URL);
  const wallet = new ethers.Wallet(process.env.FAUCET_PRIVATE_KEY, provider);
  const amount = ethers.utils.parseUnits("0.25", 18);
  const tx = await wallet.sendTransaction({
    to: toAddress,
    value: amount
  });
  await tx.wait();
  return tx.hash;
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (error) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON", details: error.message })
    };
  }

  const { address, captchaToken } = body;
  if (!address || !ethers.utils.isAddress(address)) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid wallet address" })
    };
  }
  if (!captchaToken) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Captcha token is required" })
    };
  }

  const ipHeader = event.headers["x-forwarded-for"] || event.headers["client-ip"] || "";
  const ip = ipHeader.split(",")[0].trim();
  if (!ip) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "IP address not detected" })
    };
  }

  try {
    const captchaSuccess = await verifyCaptcha(captchaToken, ip);
    if (!captchaSuccess) {
      return {
        statusCode: 403,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Captcha verification failed",
          details: "Please complete the captcha again."
        })
      };
    }
  } catch (error) {
    console.error("Captcha verification error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Error verifying captcha",
        details: error.message
      })
    };
  }

  const now = Math.floor(Date.now() / 1000);

  const walletLastClaim = await checkCooldown("wallet", address, now);
  if (walletLastClaim) {
    return {
      statusCode: 429,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "You have already claimed within the last 24 hours",
        details: "Wait until 24 hours pass since your last claim."
      })
    };
  }

  const ipLastClaim = await checkCooldown("ip", ip, now);
  if (ipLastClaim) {
    return {
      statusCode: 429,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Faucet has already been claimed from this IP",
        details: "Only one claim per IP is allowed."
      })
    };
  }

  let active = false;
  try {
    active = await isActiveAddress(address);
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to check wallet activity",
        details: error.message
      })
    };
  }
  if (!active) {
    return {
      statusCode: 403,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Wallet is not active on the required networks",
        details: "Make at least one transaction on Ethereum, Base, Polygon, Arbitrum, Linea or Optimism."
      })
    };
  }

  try {
    const txHash = await sendSTT(address);
    await updateCooldown("wallet", address, now);
    await updateCooldown("ip", ip, now);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Claim successful. 0.25 STT has been sent.",
        txHash: txHash
      })
    };
  } catch (error) {
    console.error("Error sending STT:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to send token",
        details: error.message
      })
    };
  }
};
