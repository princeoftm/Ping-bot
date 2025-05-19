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
const privateKey = '';
const account = web3Main.eth.accounts.privateKeyToAccount(privateKey);

// Contract ABI


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
function loadProgress() {
    if (fs.existsSync(PROGRESS_FILE)) {
        const data = JSON.parse(fs.readFileSync(PROGRESS_FILE));
        lastProcessedBlock = BigInt(data.lastProcessedBlock);
        lastProcessedTxHash = data.lastProcessedTxHash;
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

// Re-fetch missed events from the last saved block
// Re-fetch missed events from the last saved block in 500-block chunks
async function catchUpMissedEvents(contract, lastBlockProcessed) {
    contract = new web3Main.eth.Contract(contractABI, contractAddress);
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));

    if (lastBlockProcessed === undefined) {
        lastBlockProcessed = Number(data.lastProcessedBlock);
    } else {
        lastBlockProcessed = Number(lastBlockProcessed);
    }

    let latestBlock = Number(await web3Main.eth.getBlockNumber());

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
            await saveProgress(); // Save after each chunk

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
async function saveProgress() {
    if (lastProcessedBlock === 0){
        lastProcessedBlock = await web3Main.eth.getBlockNumber();
    }
    
    const data = {
        lastProcessedBlock: lastProcessedBlock.toString(),
        lastProcessedTxHash,
    };
    console.log('💾 Saving progress:', data);
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
}

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
    }, 1 * 1000); // Every 10 minutes
}

// Process transaction queue
async function processTxQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    console.log(`📚 Processing ${txQueue.length} queued transactions...`);

    const contract = new web3Main.eth.Contract(contractABI, contractAddress);
    let nonce = await web3Main.eth.getTransactionCount(account.address, 'pending');

    while (txQueue.length > 0) {
        const pingTxHash = txQueue.shift();
        if (pingTxHash === lastProcessedTxHash) {
            console.warn(`⚠️ Duplicate tx ignored: ${pingTxHash}`);
            continue;
        }

        console.log(`📤 Sending pong for: ${pingTxHash}`);
        const tx = contract.methods.pong(pingTxHash);

        let retries = 0;
        let success = false;

        while (retries < MAX_RETRIES && !success) {
            try {
                const gas = await tx.estimateGas({ from: account.address });
                const data = tx.encodeABI();

                const pendingBlock = await web3Main.eth.getBlock("pending");
                let txParams = {
                    to: contractAddress,
                    data,
                    gas,
                    nonce,
                    chainId: 11155111
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

                console.log(`✅ Pong transaction sent: ${receipt.transactionHash}`);

                lastProcessedTxHash = pingTxHash;
                lastProcessedBlock = receipt.blockNumber;
                nonce++;
                saveProgress();
                success = true;
            } catch (error) {
                retries++;
                const delay = Math.min(2 ** retries * 100, 60000);
                console.error(`⏳ Retry ${retries}/${MAX_RETRIES} failed: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        if (!success) {
            console.error(`❌ Max retries exceeded: ${pingTxHash}`);
            recordFailedTransaction(pingTxHash);
        }
    }

    isProcessingQueue = false;
    console.log('🏁 Queue processing complete.');
}

// Ensure progress file exists or create it
async function ensureProgressFileExists() {
    if (!fs.existsSync(PROGRESS_FILE)) {
        console.log('📄 progress.json missing. Creating...');
        var latestBlock = await web3Main.eth.getBlockNumber();
        latestBlock = latestBlock.toString();
        const defaultProgress = {
            lastProcessedBlock: latestBlock
        };

        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(defaultProgress, null, 2));
        console.log(`✅ Created progress.json from block ${latestBlock}`);
    } else {
        console.log('📂 progress.json already exists.');
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
