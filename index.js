const { Web3 } = require('web3');
const fs = require('fs');
require('dotenv').config();
// WebSocket providers for failover
const providerAlchemy = 'wss://eth-sepolia.g.alchemy.com/v2/v2MZeEDugE2xY38l3CN0Pqna1PIkxRnO';
const providerInfura = 'wss://sepolia.infura.io/ws/v3/e5dcfc3c10aa49ab8aba6109be38abd9';
let currentProvider = providerAlchemy;
const MAX_RETRIES = 140;
const FAILED_TX_FILE = './failed_transactions.json';
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
// Web3 instances
let web3Main = new Web3(currentProvider);
let web3Fallback = null;

// Event subscriptions
let subscriptionMain = null;
let subscriptionFallback = null;

// Smart contract configuration
const contractAddress = '0x7Ce0cc186b2A728dD7E1C2c06E09e6Dda0204D3c';
const privateKey = '0xa19c0658ebcc3396554bde5f05f05351c41be00ab34acc2c8bf5c3cc48264dd4';
const account = web3Main.eth.accounts.privateKeyToAccount(privateKey);

// Contract ABI
const admin = require('firebase-admin');
const serviceAccount = require('./klerosinterview-firebase-adminsdk-fbsvc-20799e3e3c.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const progressRef = db.collection('progress').doc('status'); // Singleton doc


// Event handling setup
const eventName = 'Ping';
const PROGRESS_FILE = './progress.json';
let lastProcessedTxHash = null;
let lastProcessedBlock = 0;
const txQueue = [];
let isProcessingQueue = false;

// Graceful shutdown logic
process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT received. Exiting cleanly...');
    try {
        await saveProgress();

        if (subscriptionMain) {
            try {
                await subscriptionMain.unsubscribe();
                console.log('✅ Main subscription closed.');
            } catch (e) {
                console.warn('⚠️ Failed to unsubscribe main:', e);
            }
        }

        if (subscriptionFallback) {
            try {
                await subscriptionFallback.unsubscribe();
                console.log('✅ Fallback subscription closed.');
            } catch (e) {
                console.warn('⚠️ Failed to unsubscribe fallback:', e);
            }
        }

        console.log('👋 Shutdown complete.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during exit:', error);
        process.exit(1);
    }
});

// Load progress from disk
async function loadProgress() {
    try {
        const doc = await progressRef.get();
        if (doc.exists) {
            const data = doc.data();
            lastProcessedBlock = BigInt(data.lastProcessedBlock);
            lastProcessedTxHash = data.lastProcessedTxHash;
        }
    } catch (err) {
        console.error('❌ Error loading progress from Firestore:', err);
    }
}

async function saveProgress() {
    try {
        if (lastProcessedBlock === 0){
            lastProcessedBlock = await web3Main.eth.getBlockNumber();
        }
        const data = {
            lastProcessedBlock: lastProcessedBlock.toString(),
            lastProcessedTxHash
        };
        console.log('💾 Saving progress to Firestore:', data);
        await progressRef.set(data);
    } catch (err) {
        console.error('❌ Error saving progress to Firestore:', err);
    }
}

// Store failed transaction hash
function recordFailedTransaction(txHash) {
    let failedTxs = [];
    if (fs.existsSync(FAILED_TX_FILE)) {
        failedTxs = JSON.parse(fs.readFileSync(FAILED_TX_FILE, 'utf8'));
    }

    if (!failedTxs.includes(txHash)) {
        failedTxs.push(txHash);
        fs.writeFileSync(FAILED_TX_FILE, JSON.stringify(failedTxs, null, 2));
        console.log(`📄 Saved failed transaction: ${txHash}`);
    }
}

// Initialize main subscription to Ping events
async function setupMainSubscription() {
    console.log(`🔵 Connecting to ${currentProvider}`);
    web3Main = new Web3(currentProvider);
    const contract = new web3Main.eth.Contract(contractABI, contractAddress);

    subscriptionMain = contract.events[eventName]({});

    subscriptionMain.on('connected', (id) => {
        console.log(`🔵 Main subscription active (ID: ${id})`);
    });

    subscriptionMain.on('data', async (event) => {
        console.log('🔵 Ping event received.');
        try {
            await handlePingEvent(event);
        } catch (error) {
            console.error('Main processing error. Switching to fallback...', error);
            await handleFallback();
            await handlePingEvent(event);
        }
    });

    subscriptionMain.on('error', async (error) => {
        console.error('Main connection error:', error);
        await handleFallback();
    });

    subscriptionMain.on('end', async (error) => {
        console.error('Main subscription closed:', error);
        await handleFallback();
    });
}

// Switch to fallback provider and re-subscribe
async function handleFallback() {
    console.log('🟡 Switching to fallback provider...');
    const fallbackProvider = (currentProvider === providerAlchemy) ? providerInfura : providerAlchemy;
    web3Fallback = new Web3(fallbackProvider);
    const fallbackContract = new web3Fallback.eth.Contract(contractABI, contractAddress);

    subscriptionFallback = fallbackContract.events[eventName]({});

    subscriptionFallback.on('connected', (id) => {
        console.log(`🟡 Fallback connected (ID: ${id})`);
    });

    subscriptionFallback.on('data', async (event) => {
        console.log('🟡 Ping event on fallback.');
        try {
            await handlePingEvent(event);
        } catch (error) {
            console.error('⚠️ Fallback handler error:', error);
        }
    });

    subscriptionFallback.on('error', (error) => {
        console.error('❌ Fallback subscription error:', error);
    });

    await reconnectMain();
}

async function catchUpMissedEvents(contract, lastBlockProcessed) {
    contract = new web3Main.eth.Contract(contractABI, contractAddress);

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
            : Number(await web3Main.eth.getBlockNumber());
    } else {
        lastBlockProcessed = Number(lastBlockProcessed);
    }

    const latestBlock = Number(await web3Main.eth.getBlockNumber());

    if (lastBlockProcessed > latestBlock) {
        console.warn(`⚠️ Last saved block (${lastBlockProcessed}) is ahead of latest (${latestBlock}). Resetting.`);
        lastBlockProcessed = latestBlock;
    }

    console.log(`🔎 Retrieving events from block ${lastBlockProcessed} to ${latestBlock} in chunks...`);

    const CHUNK_SIZE = 500;
    for (let fromBlock = lastBlockProcessed; fromBlock <= latestBlock; fromBlock += CHUNK_SIZE + 1) {
        const toBlock = Math.min(fromBlock + CHUNK_SIZE, latestBlock);

        try {
            const events = await contract.getPastEvents('Ping', {
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

            await progressRef.set({
                lastProcessedBlock: lastProcessedBlock.toString(),
                lastProcessedTxHash: lastProcessedTxHash || null
            }, { merge: true });

        } catch (error) {
            console.error(`❌ Failed to fetch events from block ${fromBlock} to ${toBlock}:`, error.message);
        }
    }

    setupMainSubscription(); // Reconnect live subscription after catching up
}

// Restart main subscription with alternate provider
async function reconnectMain() {
    console.log('♻️ Reconnecting main in 250ms...');
    setTimeout(async () => {
        currentProvider = (currentProvider === providerAlchemy) ? providerInfura : providerAlchemy;

        if (subscriptionMain) {
            try {
                await subscriptionMain.unsubscribe();
                console.log('✅ Main subscription closed.');
            } catch (error) {
                console.error('⚠️ Error closing main:', error);
            }
        }

        await setupMainSubscription();

        if (subscriptionFallback) {
            try {
                await subscriptionFallback.unsubscribe();
                console.log('✅ Fallback subscription closed.');
            } catch (error) {
                console.error('⚠️ Error closing fallback:', error);
            }
        }
    }, 250);
}

// Handle Ping event and queue it
async function handlePingEvent(event) {
    const pingTxHash = event.transactionHash;
    if (pingTxHash === lastProcessedTxHash) {
        console.warn(`⚠️ Skipped duplicate ping: ${pingTxHash}`);
        return;
    }
    txQueue.push(pingTxHash);
    await processTxQueue();
}

// Save latest processed state


// Retry transactions from failed list
async function retryFailedTransactions() {
    if (!fs.existsSync(FAILED_TX_FILE)) return;

    const failedTxs = JSON.parse(fs.readFileSync(FAILED_TX_FILE, 'utf8'));
    if (!Array.isArray(failedTxs) || failedTxs.length === 0) return;

    console.log(`🔁 Retrying ${failedTxs.length} failed transaction(s)...`);

    for (const txHash of [...failedTxs]) {
        txQueue.push(txHash);
    }

    fs.unlinkSync(FAILED_TX_FILE); // Clear log
    await processTxQueue();
}

// Retry failed transactions on interval
function scheduleFailedTxRetries() {
    setInterval(async () => {
        console.log('🔁 Scheduled retry of failed transactions...');
        try {
            await retryFailedTransactions();
        } catch (err) {
            console.error('❌ Retry error:', err);
        }
    }, 10*60 * 1000); // Every 10 minutes
}

// Process transaction queue
async function processTxQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    console.log(`📚 Processing ${txQueue.length} queued transactions...`);

    const contract = new web3Main.eth.Contract(contractABI, contractAddress);
    let nonce = await web3Main.eth.getTransactionCount(account.address, 'pending');

    const batchSize = 5; // Adjust this number based on rate limits and provider reliability
    while (txQueue.length > 0) {
        const batch = txQueue.splice(0, batchSize); // Remove first N txs

        const txPromises = batch.map(async (pingTxHash) => {
            if (pingTxHash === lastProcessedTxHash) {
                console.warn(`⚠️ Duplicate tx ignored: ${pingTxHash}`);
                return;
            }

            console.log(`📤 Preparing pong for: ${pingTxHash}`);
            const tx = contract.methods.pong(pingTxHash);

            for (let retries = 0; retries < MAX_RETRIES; retries++) {
                try {
                    const gas = await tx.estimateGas({ from: account.address });
                    const data = tx.encodeABI();
                    const pendingBlock = await web3Main.eth.getBlock("pending");

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
                        txParams.gasPrice = await web3Main.eth.getGasPrice();
                    }

                    const signedTx = await web3Main.eth.accounts.signTransaction(txParams, privateKey);
                    const receipt = await web3Main.eth.sendSignedTransaction(signedTx.rawTransaction);

                    console.log(`✅ Pong sent: ${receipt.transactionHash}`);

                    lastProcessedTxHash = pingTxHash;
                    lastProcessedBlock = receipt.blockNumber;
                    await saveProgress();
                    return;
                } catch (error) {
                    const delay = Math.min(2 ** retries * 100, 60000);
                    console.error(`⏳ Retry ${retries + 1}/${MAX_RETRIES} failed for ${pingTxHash}: ${error.message}`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

            console.error(`❌ Max retries exceeded for ${pingTxHash}`);
            recordFailedTransaction(pingTxHash);
        });

        await Promise.all(txPromises);
    }

    isProcessingQueue = false;
    console.log('🏁 Queue processing complete.');
}


// Ensure progress file exists or create it
async function ensureProgressFileExists() {
    const doc = await progressRef.get();
    if (!doc.exists) {
        const latestBlock = await web3Main.eth.getBlockNumber();
        await progressRef.set({
            lastProcessedBlock: latestBlock.toString(),
            lastProcessedTxHash: null,
        });
        console.log(`✅ Initialized progress in Firestore from block ${latestBlock}`);
    } else {
        console.log('📂 Progress already initialized in Firestore.');
    }
}


// Periodically re-check missed events
function scheduleMissedPingCheck() {
    setInterval(async () => {
        console.log('⏰ Checking for missed Ping events...');
        try {
            await catchUpMissedEvents();
        } catch (error) {
            console.error('❌ Missed ping check failed:', error);
        }
    }, 60 * 60 * 1000); // Every 1 hour
}

// Startup logic
(async () => {
    await ensureProgressFileExists();
    await loadProgress();
    await retryFailedTransactions();
    catchUpMissedEvents();
    scheduleMissedPingCheck();
    scheduleFailedTxRetries();
    console.log(`🚀 Monitoring ${eventName} events on contract: ${contractAddress}`);
})();
setupMainSubscription();
