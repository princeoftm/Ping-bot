---
# Ping-Pong Bot

This project is a Node.js application that monitors "Ping" events on an Ethereum smart contract and automatically sends a "Pong" transaction in response. It's designed for high availability and resilience, featuring WebSocket provider failover, transaction retries, and progress persistence.

## Features

* **Real-time Event Monitoring:** Subscribes to `Ping` events from a specified smart contract.
* **Automated "Pong" Response:** Automatically constructs and sends a `pong` transaction for each detected `Ping` event.
* **WebSocket Provider Failover:** Seamlessly switches between Alchemy and Infura WebSocket providers if the primary connection experiences issues.
* **Transaction Retries:** Implements an exponential backoff strategy for failed "Pong" transactions to maximize success rates.
* **Persistent Progress Tracking:** Saves the last processed block and transaction hash to Firestore, enabling the bot to resume operations from where it left off after restarts.
* **Missed Event Catch-up:** Periodically checks for and processes any `Ping` events that might have been missed due to downtime or network interruptions.
* **Failed Transaction Logging:** Records unrecoverable failed transactions to a local file (`failed_transactions.json`) for later inspection and manual retry.
* **Graceful Shutdown:** Ensures that progress is saved and subscriptions are properly closed on application termination (e.g., via `Ctrl+C`).

## Getting Started

### Prerequisites

* Node.js (LTS version recommended)
* A Sepolia Ethereum account with some test ETH
* Alchemy and Infura WebSocket API keys (or similar providers)
* Firebase project setup with a service account key for Firestore access.

### Installation

1.  **Clone the repository:**
    ```bash
    git clone [repository_url]
    cd [repository_name]
    ```

2.  **Install dependencies:**
    ```bash
    npm install web3 dotenv firebase-admin
    ```

3.  **Environment Variables:**
    Create a `.env` file in the project root and add your private key:
    ```
    PRIVATE_KEY="your_ethereum_private_key_here"
    ```
    **Note:** For production environments, consider more secure methods for handling private keys.

4.  **Firebase Service Account Key:**
    Download your Firebase service account key JSON file and place it in the project root, named `klerosinterview-firebase-adminsdk-fbsvc-20799e3e3c.json`.

5.  **Smart Contract ABI and Address:**
    Ensure the `contractABI` array and `contractAddress` variable in `index.js` are correctly set for your deployed "Ping-Pong" contract.

### Running the Bot

```bash
node index.js
Configuration
providerAlchemy and providerInfura: Update these with your actual WebSocket URLs.

contractAddress: The address of your deployed smart contract.

privateKey: The private key of the Ethereum account that will send "Pong" transactions.

MAX_RETRIES: Maximum number of times to retry sending a "Pong" transaction.

FAILED_TX_FILE: Path to the file where failed transaction hashes are stored.

PROGRESS_FILE: (Deprecated in favor of Firestore) Path to the file for saving progress (now uses Firestore).

CHUNK_SIZE: (in catchUpMissedEvents) Determines the number of blocks to fetch at once when catching up on past events.

Retry Intervals: The scheduleFailedTxRetries and scheduleMissedPingCheck functions define how often the bot attempts to retry failed transactions and check for missed events, respectively.


How it Works

Initialization:

Loads the last processed block and transaction hash from Firestore.
Attempts to retry any previously failed transactions.
Initializes a connection to the primary WebSocket provider (Alchemy).

Event Subscription:
Subscribes to the Ping event on the specified smart contract.
Event Handling (handlePingEvent):

When a Ping event is received, its transaction hash is added to a processing queue.
Queue Processing (processTxQueue):

Processes transactions from the queue in batches.

For each Ping transaction hash, it constructs and signs a pong transaction.

Includes logic for EIP-1559 gas estimation if the network supports it.

Sends the signed transaction to the Ethereum network.

If a transaction fails, it retries with exponential backoff.

If max retries are exceeded, the transaction hash is recorded in failed_transactions.json.

Updates the last processed block and transaction hash in Firestore upon successful "Pong" 
transmission.

Failover (handleFallback, reconnectMain):


If the primary WebSocket connection encounters an error or closes, the bot attempts to switch to the fallback provider (Infura).

It then attempts to reconnect to the original main provider after a short delay.
Catch-up (catchUpMissedEvents):

Periodically queries past Ping events from the smart contract, starting from the last processed block, to ensure no events were missed during downtime.

Failed Transaction Retries (retryFailedTransactions, scheduleFailedTxRetries):

On startup and at regular intervals, the bot reads the failed_transactions.json file and re-queues any un-sent "Pong" transactions for another attempt.

Graceful Shutdown:

On SIGINT (Ctrl+C), the bot saves its current progress to Firestore and unsubscribes from all active WebSocket connections before exiting.