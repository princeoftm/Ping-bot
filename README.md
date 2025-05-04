
# **Transaction Resender with Retry Logic**

This script listens for `Ping` events on an Ethereum contract, processes them by sending a `Pong` response, and includes retry logic to handle transaction failures using exponential backoff.

### **Features**

- **Event Listening**: Listens for `Ping` events on the contract.
- **Transaction Processing**: Sends a `Pong` response for each `Ping` event.
- **Exponential Retry Logic**: Retries failed transactions up to a specified number of attempts (up to 140 retries by default) with exponential backoff.
- **Failed Transactions**: Keeps track of failed transactions in a `failed_transactions.json` file and retries them later.
- **Automatic Retries**: Failed transactions are automatically retried on script startup and periodically thereafter (every 10 minutes).
- **Graceful Shutdown**: Handles graceful shutdown, ensuring that progress is saved, and subscriptions are unsubscribed.

---

### **Prerequisites**

1. **Node.js**: Make sure Node.js is installed on your machine.
   - [Download Node.js](https://nodejs.org/)
   
2. **Install Dependencies**: 

   Run the following command to install the necessary packages:

   ```bash
   npm install web3 fs
   ```

---

### **Setup**

1. **Configure Web3 Providers and Contract Information**

   Open the script file and modify the following variables:

   - **`providerAlchemy`**: Your Alchemy WebSocket provider URL.
   - **`providerInfura`**: Your Infura WebSocket provider URL.
   - **`contractABI`**: The ABI of the contract you're interacting with.
   - **`contractAddress`**: The address of the Ethereum contract you're monitoring.
   - **`privateKey`**: The private key used to sign transactions.(Please use .env if you're putting it online ;( )

   Example:
   ```js
   const providerAlchemy = 'wss://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_API_KEY';
   const providerInfura = 'wss://sepolia.infura.io/ws/v3/YOUR_INFURA_API_KEY';
   const contractABI = [...];  // Your contract ABI here
   const contractAddress = '0xYourContractAddress';
   const privateKey = '0xYourPrivateKey';
   ```

2. **Progress File (`progress.json`)**

   The script automatically creates and updates a file called `progress.json` to store the last processed block and transaction hash. If this file does not exist, the script will create it for you.

---

### **How to Run**

1. **Start the Script**

   Run the script using Node.js:

   ```bash
   node script.js
   ```

   This will start listening for `Ping` events, process transactions, and handle retries.

2. **Graceful Shutdown**

   The script will handle graceful shutdown if you press `Ctrl+C`. It will save progress and unsubscribe from the event listeners.

---

### **File Descriptions**

- **`progress.json`**: Tracks the last processed block and transaction hash to avoid replaying transactions.
- **`failed_transactions.json`**: Stores the transaction hashes of failed transactions. These transactions will be retried automatically on script restart or based on the retry schedule.

---

### **Exponential Retry Logic**

- Failed transactions will be retried with exponential backoff. The script will attempt the transaction again after 5 seconds, then 10 seconds, then 20 seconds, and so on, up to a maximum of 140 retries.
- After 140 retries, the transaction will be considered permanently failed and will be saved in `failed_transactions.json` for manual review.

---

### **Periodic Retry of Failed Transactions**

- Every 10 minutes, the script will check the `failed_transactions.json` file and attempt to resend any transactions that failed previously.
- Failed transactions will also be retried on startup, if any are found in the `failed_transactions.json` file.

---

### **Customizations**

1. **Retry Interval**: You can change the retry interval or the number of retries by adjusting the variables in the script.
   
2. **Event Name**: If your contract emits different event names, you can update the `eventName` variable to reflect the correct event.

---

### **Troubleshooting**

- **Failed to connect to WebSocket**: Ensure your WebSocket URLs are correct and that you have a valid API key for Alchemy or Infura.
- **Transaction Gas Limit Exceeded**: Ensure that the transaction's gas limit is correctly estimated and sufficient.

---

### **License**

MIT License
