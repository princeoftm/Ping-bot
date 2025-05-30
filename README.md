# 🛎Ping/Pong Listener on Sepolia

A reliable event-driven bot that listens for `Ping()` events from a verified contract on the Sepolia testnet and responds with a `pong()` transaction that includes the hash of the Ping event transaction. Built to be fault-tolerant and resume gracefully across crashes or network failures.

---

## 🚀 Overview

The contract periodically emits `Ping()` events. The bot responds by calling `pong(bytes32 txHash)` with the transaction hash of each Ping.

---



## 🧠 Features & Reliability

This bot addresses and **defends against the following problems**:

### ✅ **1. Start from a block and never miss a Ping**

- **Progress is stored in Firestore** (`progress/status`) with the last processed:
  - Block number
  - Ping transaction hash
- On startup, missed events are recovered using `getPastEvents()` from the saved block onward.
- Catches up all events **before** listening live.

### ✅ **2. Exactly one pong() per ping()**

- Keeps a **deduplicated Set** of processed transaction hashes in-memory (`processedTxs`)
- Remembers the last processed tx and block for stateful consistency
- Prevents reprocessing duplicate Pings even after restarts or failures

### ✅ **3. Handles WebSocket disconnects**

- Uses Alchemy WebSocket for real-time events
- On disconnect or idle, the WS could silently die — we mitigate by:
  - Using `getPastEvents()` to catch missed events
  - Designing logic to resume processing without gaps

### ✅ **4. Handles network failures and retries**

- Includes **robust retry logic** with exponential backoff for failed transactions
- Saves failed transactions to `failed_transactions.json` for future reprocessing if needed
- Avoids overwhelming the network by spacing retries

### ✅ **5. Prevents nonce collisions / failed txs after restart**

- Uses **manual nonce management** with `pending` nonce reads
- Processes txs sequentially to avoid parallel nonce conflicts
- Resumes with latest nonce on restart

---

## 🔧 How to Run

### 1. Clone & install dependencies

```bash
git clone https://github.com/YOUR_USERNAME/kleros-pingpong-bot.git
cd kleros-pingpong-bot
npm install
```

### 2. Environment setup

Create a `.env` file with:

```env
ALCHEMY_API_KEY=v2MZeEDugE2xY38l3CN0Pqna1PIkxRnO
```

Add your Alchemy Sepolia API key, or replace it inline.

### 3. Firebase setup

Place your service account key file as:

```bash
./klerosinterview-firebase-adminsdk-fbsvc-cf50ab75c6.json
```

### 4. Start the bot

```bash
node index.js
```

The bot will:
- Load last progress from Firestore
- Catch up on missed Ping() events
- Start listening via WebSocket
- Call `pong(txHash)` for each new Ping

---

## 📁 Files

- `index.js`: Main bot logic
- `.env`: API key secrets
- `failed_transactions.json`: Stores Pings that failed after max retries
- `firebase-adminsdk-*.json`: Firebase service account key

---

## ⚠️ Error Handling Summary

| Error Type                          | Mitigation                                                                 |
|------------------------------------|----------------------------------------------------------------------------|
| WebSocket dies silently            | Catch up logic via `getPastEvents()` handles gaps                          |
| Network failure                    | Retry `pong()` tx with exponential backoff up to `MAX_RETRIES`            |
| Nonce conflict                     | Sequential tx queue + manual nonce management avoids conflicts            |
| Transaction dropped / not mined   | Retries; if persistent, logs tx hash to `failed_transactions.json`        |
| Bot crash or restart              | Resumes from last saved progress in Firestore                             |
| Block rollback / fork              | Handles idempotently using tx hashes                                       |

---

## 🧪 Testing

To test:

1. Deploy or use the provided contract.
2. Call the `ping()` method.
3. Wait for the bot to detect and reply with `pong(txHash)`.
4. Confirm `pong()` was mined and matched the original ping txHash.
5. Try killing and restarting the bot to confirm progress resumes correctly.

---

## 📎 Notes

- Ensure your bot address has enough Sepolia ETH from [https://sepoliafaucet.com/](https://sepoliafaucet.com/).
- Contract source is verified on Etherscan: [View here](https://sepolia.etherscan.io/address/0xA7F42ff7433cB268dD7D59be62b00c30dEd28d3D#code)
- You may redeploy the contract if needed.

---
