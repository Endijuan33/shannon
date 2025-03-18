const { ethers } = require("ethers");

exports.handler = async (event, context) => {
  try {
    const provider = new ethers.providers.JsonRpcProvider(process.env.SOMNIA_TESTNET_RPC_URL);
    const wallet = new ethers.Wallet(process.env.FAUCET_PRIVATE_KEY, provider);
    const balanceBN = await provider.getBalance(wallet.address);
    const balance = ethers.utils.formatUnits(balanceBN, 18);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ balance })
    };
  } catch (err) {
    console.error("Error fetching faucet balance:", err);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        error: "Failed to retrieve balance",
        details: err.message
      })
    };
  }
};
