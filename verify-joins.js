require("dotenv").config();
const { Aptos, AptosConfig, Network } = require("@aptos-labs/ts-sdk");

async function verifyJoins() {
  const aptosConfig = new AptosConfig({
    network: Network.CUSTOM,
    fullnode: process.env.MOVEMENT_NODE_URL || "https://testnet.movementnetwork.xyz/v1",
  });
  const aptos = new Aptos(aptosConfig);
  const MODULE_ADDRESS = process.env.MODULE_ADDRESS;

  console.log(`🔍 Verifying On-Chain Joins for Module: ${MODULE_ADDRESS}`);
  
  try {
    const resource = await aptos.getAccountResource({
      accountAddress: MODULE_ADDRESS,
      resourceType: `${MODULE_ADDRESS}::game::GameStore`
    });

    if (!resource || !resource.games) {
      console.log("❌ GameStore not found or empty.");
      return;
    }

    console.log(`\nFound ${resource.games.length} games on-chain:\n`);

    resource.games.forEach((game, index) => {
      const participants = game.participants || [];
      console.log(`🎮 Game #${index}: ${game.name?.value || 'Unnamed'}`);
      console.log(`   - Status: ${game.is_paused ? '⏸ PAUSED' : '▶️ ACTIVE'}`);
      console.log(`   - Participants (${participants.length}):`);
      if (participants.length === 0) {
        console.log(`     (No on-chain participants)`);
      } else {
        participants.forEach(addr => {
          console.log(`     👤 ${addr}`);
        });
      }
      console.log('--------------------------------------------------');
    });

  } catch (err) {
    console.error("❌ Error fetching GameStore:", err.message);
  }
}

verifyJoins();
