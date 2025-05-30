const { Alchemy, Network, Utils } = require("alchemy-sdk");
const { Web3 } = require('web3');
const fs = require("fs");
require("dotenv").config();

const providerAlchemy = 'wss://eth-sepolia.g.alchemy.com/v2/v2MZeEDugE2xY38l3CN0Pqna1PIkxRnO';
const admin = require("firebase-admin");
const serviceAccount = require("./klerosinterview-firebase-adminsdk-fbsvc-cf50ab75c6.json");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const progressRef = db.collection("progress").doc("status");
const processedTxs = new Set();

const ALCHEMY_API_KEY = "v2MZeEDugE2xY38l3CN0Pqna1PIkxRnO";
let web3 = new Web3(providerAlchemy);

const settings = {
  apiKey: ALCHEMY_API_KEY,
  network: Network.ETH_SEPOLIA,
};
const alchemy = new Alchemy(settings);

const FAILED_TX_FILE = "./failed_transactions.json";
const contractAddress = "0xA7F42ff7433cB268dD7D59be62b00c30dEd28d3D";
const privateKey = "0xa19c0658ebcc3396554bde5f05f05351c41be00ab34acc2c8bf5c3cc48264dd4";
const contractABI = [ 
    { "inputs": [], "stateMutability": "nonpayable", "type": "constructor" },
    { "anonymous": false, "inputs": [{ "indexed": false, "internalType": "address", "name": "pinger", "type": "address" }], "name": "NewPinger", "type": "event" },
    { "anonymous": false, "inputs": [], "name": "Ping", "type": "event" },
    { "anonymous": false, "inputs": [{ "indexed": false, "internalType": "bytes32", "name": "txHash", "type": "bytes32" }], "name": "Pong", "type": "event" },
    { "inputs": [{ "internalType": "address", "name": "_pinger", "type": "address" }], "name": "changePinger", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [], "name": "ping", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [], "name": "pinger", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "internalType": "bytes32", "name": "_txHash", "type": "bytes32" }], "name": "pong", "outputs": [], "stateMutability": "nonpayable", "type": "function" }
];

const contract =  new web3.eth.Contract(contractABI, contractAddress);

const eventName = "Ping";
const pingEventSig = web3.utils.sha3("Ping()");

let lastProcessedTxHash = null;
let lastProcessedBlock = 0;
let txQueue = [];
let isProcessingQueue = false;
const MAX_RETRIES = 140;

const account = web3.eth.accounts.privateKeyToAccount(privateKey);
const web3Http = new Web3(`https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`);

async function saveProgress() {
  if (lastProcessedBlock === 0) {
    lastProcessedBlock = await web3Http.eth.getBlockNumber();
  }
  await progressRef.set({
    lastProcessedBlock: lastProcessedBlock.toString(),
    lastProcessedTxHash,
  });
}

function recordFailedTransaction(txHash) {
  let failedTxs = fs.existsSync(FAILED_TX_FILE) ? JSON.parse(fs.readFileSync(FAILED_TX_FILE)) : [];
  if (!failedTxs.includes(txHash)) {
    failedTxs.push(txHash);
    fs.writeFileSync(FAILED_TX_FILE, JSON.stringify(failedTxs, null, 2));
  }
}

async function handlePingEvent({ transactionHash }) {
  if (!transactionHash || processedTxs.has(transactionHash)) return;
  if (transactionHash === lastProcessedTxHash) return;

  processedTxs.add(transactionHash);
  txQueue.push(transactionHash);
  await processTxQueue();
}


async function processTxQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  const contract = new web3Http.eth.Contract(contractABI, contractAddress);
  let nonce = await web3Http.eth.getTransactionCount(account.address, "pending");

  while (txQueue.length > 0) {
    const pingTxHash = txQueue.shift();
    const tx = contract.methods.pong(pingTxHash);

    for (let retries = 0; retries < MAX_RETRIES; retries++) {
      try {
        const gas = await tx.estimateGas({ from: account.address });
        const data = tx.encodeABI();
        const pendingBlock = await web3Http.eth.getBlock("pending");

        const txParams = {
          to: contractAddress,
          data,
          gas,
          nonce: nonce++,
          chainId: 11155111,
        };

        if (pendingBlock.baseFeePerGas) {
          const baseFee = BigInt(pendingBlock.baseFeePerGas);
          const priorityFee = 1_500_000_000n;
          const maxFee = baseFee + priorityFee;
          txParams.maxFeePerGas = maxFee.toString();
          txParams.maxPriorityFeePerGas = priorityFee.toString();
        } else {
          txParams.gasPrice = await web3Http.eth.getGasPrice();
        }

        const signedTx = await web3.eth.accounts.signTransaction(txParams, privateKey);
        const receipt = await web3Http.eth.sendSignedTransaction(signedTx.rawTransaction);

        lastProcessedTxHash = pingTxHash;
        lastProcessedBlock = receipt.blockNumber;
        await saveProgress();
        break;
      } catch (error) {
        if (retries === MAX_RETRIES - 1) {
          recordFailedTransaction(pingTxHash);
        }
        await new Promise((r) => setTimeout(r, Math.min(2 ** retries * 100, 60000)));
      }
    }
  }
  isProcessingQueue = false;
}

(async () => {
  console.log("🚀 Starting up...");

  try {
    const doc = await progressRef.get();
    if (doc.exists) {
      const data = doc.data();
      lastProcessedBlock = Number(data.lastProcessedBlock);
      lastProcessedTxHash = data.lastProcessedTxHash;
    }

    // 🧹 Catch up missed events BEFORE listening
    await catchUpMissedEvents(lastProcessedBlock);

    // 🛰️ Then start websocket listener
    alchemy.ws.on({ address: contractAddress, topics: [pingEventSig] }, async (log) => {
      console.log("🔵 Ping() event received");
      await handlePingEvent({ transactionHash: log.transactionHash });
    });

    console.log("✅ Ready and listening for new events!");
  } catch (err) {
    console.error("❌ Error during startup:", err);
  }
})();


async function catchUpMissedEvents(lastBlockProcessed) {
  const contract = new web3Http.eth.Contract(contractABI, contractAddress);
  let savedProgress = {};
  
  try {
    const doc = await progressRef.get();
    if (doc.exists) {
      savedProgress = doc.data();
    }
  } catch (error) {
    console.error('❌ Failed to load progress from Firestore:', error);
  }

  if (lastBlockProcessed === undefined) {
    lastBlockProcessed = savedProgress.lastProcessedBlock
      ? Number(savedProgress.lastProcessedBlock)
      : Number(await web3Http.eth.getBlockNumber());
  } else {
    lastBlockProcessed = Number(lastBlockProcessed);
  }

  const latestBlock = Number(await web3Http.eth.getBlockNumber());

  if (lastBlockProcessed > latestBlock) {
    console.warn(`⚠️ Last saved block (${lastBlockProcessed}) is ahead of latest (${latestBlock}). Resetting.`);
    lastBlockProcessed = latestBlock;
  }

  console.log(`🔎 Retrieving events from block ${lastBlockProcessed} to ${latestBlock} in chunks...`);

  const CHUNK_SIZE = 499;
  for (let fromBlock = lastBlockProcessed; fromBlock <= latestBlock; fromBlock += CHUNK_SIZE + 1) {
    const toBlock = Math.min(fromBlock + CHUNK_SIZE, latestBlock);

    try {
      const events = await contract.getPastEvents("Ping", {
        fromBlock,
        toBlock,
      });

      if (events.length > 0) {
        console.log(`🔍 Retrieved ${events.length} events from block ${fromBlock} to ${toBlock}`);
      }

      for (const event of events) {
        await handlePingEvent(event);
      }

      lastProcessedBlock = toBlock;

      await progressRef.set(
        {
          lastProcessedBlock: lastProcessedBlock.toString(),
          lastProcessedTxHash: lastProcessedTxHash || null,
        },
        { merge: true }
      );
    } catch (error) {
      console.error(`❌ Failed to fetch events from block ${fromBlock} to ${toBlock}:`, error.message);
    }
  }
}
