const { ethers } = require("ethers");

const NETWORKS = [
  { name: 'Ethereum', rpc: process.env.ETH_RPC_URL },
  { name: 'Base', rpc: process.env.BASE_RPC_URL },
  { name: 'Polygon', rpc: process.env.POLYGON_RPC_URL },
  { name: 'Arbitrum', rpc: process.env.ARBITRUM_RPC_URL },
  { name: 'Linea', rpc: process.env.LINEA_RPC_URL },
];

const walletCooldownData = {};
const ipCooldownData = {};

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
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (error) {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const { address, captchaToken } = body;
  if (!address || !ethers.utils.isAddress(address)) {
    return { statusCode: 400, body: "Invalid wallet address" };
  }
  if (!captchaToken) {
    return { statusCode: 400, body: "Captcha token is required" };
  }

  const ipHeader = event.headers["x-forwarded-for"] || event.headers["client-ip"] || "";
  const ip = ipHeader.split(",")[0].trim();
  if (!ip) {
    return { statusCode: 400, body: "IP address not detected" };
  }

  try {
    const captchaSuccess = await verifyCaptcha(captchaToken, ip);
    if (!captchaSuccess) {
      return { statusCode: 403, body: "Captcha verification failed" };
    }
  } catch (error) {
    console.error("Captcha verification error:", error);
    return { statusCode: 500, body: "Error verifying captcha" };
  }

  if (ipCooldownData[ip]) {
    return { statusCode: 429, body: "Faucet has already been claimed from this IP" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (walletCooldownData[address] && now - walletCooldownData[address] < 86400) {
    return { statusCode: 429, body: "You have already claimed within the last 24 hours" };
  }

  let active = false;
  try {
    active = await isActiveAddress(address);
  } catch (error) {
    return { statusCode: 500, body: "Failed to check wallet activity" };
  }
  if (!active) {
    return { statusCode: 403, body: "Wallet is not active on the required networks" };
  }

  try {
    const txHash = await sendSTT(address);
    walletCooldownData[address] = now;
    ipCooldownData[ip] = now;
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Claim successful. 0.25 STT has been sent.",
        txHash: txHash
      })
    };
  } catch (error) {
    console.error("Error sending STT:", error);
    return { statusCode: 500, body: "Failed to send token" };
  }
};
