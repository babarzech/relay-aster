import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

// contract address of aster on arbiscan = https://arbiscan.io/address/0x9e36cb86a159d479ced94fa05036f235ac40e1d5#writeProxyContract
// contract address of aster on bscscan = https://bscscan.com/address/0x128463a60784c4d3f46c23af3f65ed859ba87974#writeProxyContract


// --- Configuration ---
const RELAY_API_URL = 'https://api.relay.link';

// User Config
const USER_ADDRESS = '0x1FDBB560d5006dC348421aF4A8C15b2617B1C138'; // Replace with your address if different
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
    // const decimals = 1000000000000000000;
    const amount = 100000000000000000
    // const amount = 0.1 * decimals;
    try {

        const iface = new ethers.Interface(DESTINATION_ABI);
        const callData = iface.encodeFunctionData("depositFor", [
            DESTINATION_CURRENCY, // currency
            USER_ADDRESS,         // forAddress
            amount.toString(),         // amount (USDT value arriving)
            BROKER_ID             // broker
        ]);

        console.log(`Call Data: ${callData}`);


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
