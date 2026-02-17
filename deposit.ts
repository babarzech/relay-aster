import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

// --- Configuration ---
const RELAY_API_URL = 'https://api.relay.link';

// User Config
const USER_ADDRESS = '0x03508bb71268bba25ecacc8f620e01866650532c'; // Replace with your address if different
const AMOUNT_TO_SEND_ETH = '0.00005'; // 0.00005 ETH
const BROKER_ID = '1000'; // Broker ID as per your requirement

// Chain Config
const ORIGIN_CHAIN_ID = 42161; // Arbitrum One
const DESTINATION_CHAIN_ID = 56; // BSC

// Currencies
const ORIGIN_CURRENCY = '0x0000000000000000000000000000000000000000'; // ETH (Native on Arbitrum)
const DESTINATION_CURRENCY = '0x55d398326f99059ff775485246999027b3197955'; // USDT (BSC-USD)

// Contracts
const DESTINATION_CONTRACT = '0x128463A60784c4D3f46c23Af3f65Ed859Ba87974'; // Aster Treasury

// RPC for Arbitrum (needed for sending transaction)
const ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';

// ABI for depositFor
// function depositFor(address currency, address forAddress, uint256 amount, uint256 broker)
const DESTINATION_ABI = [
    "function depositFor(address currency, address forAddress, uint256 amount, uint256 broker) external payable"
];

async function main() {
    try {
        console.log('--- Relay Deposit Setup ---');
        console.log(`User: ${USER_ADDRESS}`);
        console.log(`Sending: ${AMOUNT_TO_SEND_ETH} ETH`);
        console.log(`From Chain: ${ORIGIN_CHAIN_ID} -> To Chain: ${DESTINATION_CHAIN_ID}`);
        console.log('---------------------------');

        // Check Private Key
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            console.warn('WARNING: PRIVATE_KEY not found in .env file. Running in Dry-Run mode (Quote Only).');
        }

        // Amount in Wei
        const amountWei = ethers.parseEther(AMOUNT_TO_SEND_ETH);
        console.log(`Amount in Wei: ${amountWei.toString()}`);

        // --- Step 1: Get Preliminary Quote to estimate Output Amount (USDT) ---
        console.log('\n--- Step 1: Fetching Estimated Output Amount ---');

        const estimationQuoteParams = {
            user: USER_ADDRESS,
            originChainId: ORIGIN_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            originCurrency: ORIGIN_CURRENCY,
            destinationCurrency: DESTINATION_CURRENCY,
            amount: amountWei.toString(),
            tradeType: 'EXACT_INPUT'
        };

        const estResponse = await axios.post(`${RELAY_API_URL}/quote`, estimationQuoteParams);
        const estData = estResponse.data;

        // Log all keys to debug response structure
        // console.log('Estimation Quote Keys:', Object.keys(estData));
        if (estData.details) console.log('Details available.');

        let outputAmount = '0';
        if (estData.details && estData.details.currencyOut) {
            outputAmount = estData.details.currencyOut.amount;
        } else if (estData.solver && estData.solver.amountOut) {
            outputAmount = estData.solver.amountOut;
        } else {
            // Fallback: Check if there's a 'toAmount' or similar in top level
            // If not found, we might need to assume 0 or check logs
            console.log("Could not exact output amount. Using 0 for encoding (Contract might fail if it requires exact match).");
            console.log("Full Est Data:", JSON.stringify(estData, null, 2));
        }

        console.log(`Estimated Output (USDT): ${outputAmount}`);

        // --- Step 2: Construct Call Data for 'depositFor' ---
        console.log('\n--- Step 2: Constructing Call Data ---');

        const iface = new ethers.Interface(DESTINATION_ABI);
        const callData = iface.encodeFunctionData("depositFor", [
            DESTINATION_CURRENCY, // currency
            USER_ADDRESS,         // forAddress
            outputAmount,         // amount (USDT value arriving)
            BROKER_ID             // broker
        ]);

        console.log(`Call Data: ${callData}`);

        // --- Step 3: Get Final Quote with Deposit Address ---
        console.log('\n--- Step 3: Fetching Final Deposit Address ---');

        const finalQuoteParams = {
            user: USER_ADDRESS,
            originChainId: ORIGIN_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            originCurrency: ORIGIN_CURRENCY,
            destinationCurrency: DESTINATION_CURRENCY,
            amount: amountWei.toString(),
            tradeType: 'EXACT_OUTPUT',
            useDepositAddress: true,
            txs: [
                {
                    to: DESTINATION_CONTRACT,
                    value: "0",
                    data: callData
                }
            ]
        };

        const finalResponse = await axios.post(`${RELAY_API_URL}/quote`, finalQuoteParams);
        const finalData = finalResponse.data;

        // Check for deposit address in 'address' or 'steps'
        let depositAddress = finalData.address;

        if (!depositAddress && finalData.steps) {
            console.log("Searching in steps for deposit address...");
            // sometimes it's inside a step with id 'deposit' or similar
            for (const step of finalData.steps) {
                if (step.items) {
                    for (const item of step.items) {
                        if (item.status?.requestId && item.data?.depositAddress) {
                            depositAddress = item.data.depositAddress;
                            break;
                        }
                    }
                }
            }
        }

        if (!depositAddress) {
            console.log('--- FINAL QUOTE RESPONSE KEYS ---');
            console.log(Object.keys(finalData));
            console.log('--- FULL FINAL QUOTE RESPONSE ---');
            console.log(JSON.stringify(finalData, null, 2));
            console.log('---------------------------------');
            console.log('No direct "address" field found. Please check the structure above.');
            return;
        }

        console.log(`\n>>> DEPOSIT ADDRESS RECEIVED: ${depositAddress} <<<`);

        // --- Step 4: Send Transaction ---
        if (privateKey) {
            console.log('\n--- Step 4: Sending Transaction ---');

            const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC_URL);
            const wallet = new ethers.Wallet(privateKey, provider);

            const balance = await provider.getBalance(wallet.address);
            console.log(`Wallet Balance: ${ethers.formatEther(balance)} ETH`);

            if (balance < amountWei) {
                console.error(`Insufficient balance. Have ${ethers.formatEther(balance)} ETH, need ${ethers.formatEther(amountWei)} ETH + gas`);
                return;
            }

            console.log(`Sending ${ethers.formatEther(amountWei)} ETH to ${depositAddress}...`);

            const tx = await wallet.sendTransaction({
                to: depositAddress,
                value: amountWei
            });

            console.log(`Transaction Sent! Hash: ${tx.hash}`);
            console.log(`Explorer: https://arbiscan.io/tx/${tx.hash}`);

            console.log('\nWaiting for confirmation...');
            await tx.wait();

            console.log('Transaction Confirmed!');
        } else {
            console.log('\n--- Step 4: Transaction Skipped (No Private Key) ---');
            console.log(`To execute, add PRIVATE_KEY to .env and ensure it has ${AMOUNT_TO_SEND_ETH} ETH on Arbitrum.`);
            console.log(`You would send ${AMOUNT_TO_SEND_ETH} ETH to ${depositAddress}`);
        }

    } catch (error: any) {
        console.error('\n!!! ERROR !!!');
        if (error.response) {
            console.error('API Error Response:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Error:', error.message);
        }
    }
}

main();
