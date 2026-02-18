import { ethers } from "ethers";
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });
// --- CONFIGURATION ---
const RPC_URL = "https://bsc-dataseed.binance.org/";
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Securely store this!
const ASTERDEX_ADDRESS = "0x128463a60784c4d3f46c23af3f65ed859ba87974";
const USDT_ADDRESS = "0x55d398326f99059ff775485246999027b3197955";

// Parameters for the call
const DEPOSIT_AMOUNT_HUMAN = "0.05";
const BENEFICIARY = "0x1FDBB560d5006dC348421aF4A8C15b2617B1C138";
const BROKER_ID = "1000";

// ABIs — matches the on-chain AstherusVault implementation
// depositFor(address currency, address forAddress, uint256 amount, uint256 broker) external payable
const ASTERDEX_ABI = [
    "function depositFor(address currency, address forAddress, uint256 amount, uint256 broker) external payable"
];

// Known custom errors from AstherusVault + OpenZeppelin AccessControl
const ERROR_ABI = [
    "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
    "error CurrencyNotSupport(address currency)",
    "error ZeroAmount()",
    "error ValueNotZero()",
    "error AmountIllegal(uint256 supported, uint256 actual)",
    "error ZeroAddress()",
];

// Human-readable role names
const KNOWN_ROLES: Record<string, string> = {
    "0x2561bf26f818282a3be40719542054d2173eb0d38539e8a8d3cff22f29fd2384": "DEPOSIT_ROLE",
    "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775": "ADMIN_ROLE",
    "0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a": "PAUSE_ROLE",
    "0x97667070c54ef182b0f5858b034beac1b6f3089aa2d3188bb1e8929f4fa9b929": "OPERATE_ROLE",
    "0x3bea619e54e11e03fe03b4f1f02ab2969e tried1a75ee9c17fee29f90bb1a84b97": "TOKEN_ROLE",
};

function decodeContractError(error: any): string {
    const data = error?.data || error?.info?.error?.data || error?.error?.data;
    if (!data || typeof data !== 'string') {
        return error.reason || error.message || 'Unknown error';
    }

    const iface = new ethers.Interface(ERROR_ABI);
    try {
        const decoded = iface.parseError(data);
        if (!decoded) return `Raw revert data: ${data}`;

        switch (decoded.name) {
            case 'AccessControlUnauthorizedAccount': {
                const account = decoded.args[0];
                const roleHash = decoded.args[1];
                const roleName = KNOWN_ROLES[roleHash.toLowerCase()] || roleHash;
                return `AccessControlUnauthorizedAccount: wallet ${account} does NOT have the required role "${roleName}". The contract admin must grant this role to your wallet.`;
            }
            case 'CurrencyNotSupport':
                return `CurrencyNotSupport: token ${decoded.args[0]} is not a supported deposit currency on this vault.`;
            case 'ZeroAmount':
                return `ZeroAmount: the deposit amount cannot be zero.`;
            case 'ValueNotZero':
                return `ValueNotZero: msg.value must be 0 for ERC20 deposits (you sent BNB with a token deposit).`;
            case 'AmountIllegal':
                return `AmountIllegal: expected ${decoded.args[0]}, but actual was ${decoded.args[1]}.`;
            case 'ZeroAddress':
                return `ZeroAddress: one of the addresses provided was the zero address.`;
            default:
                return `${decoded.name}(${decoded.args.join(', ')})`;
        }
    } catch {
        // Check for standard revert string
        try {
            const result = iface.decodeFunctionResult("depositFor", data);
            return `Unexpected result: ${result}`;
        } catch {
            return `Raw revert data: ${data}`;
        }
    }
}
const ERC20_ABI = [
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function allowance(address owner, address spender) public view returns (uint256)",
    "function decimals() public view returns (uint8)"
];

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY!, provider);

    const asterContract = new ethers.Contract(ASTERDEX_ADDRESS, ASTERDEX_ABI, wallet);
    const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet);

    // 1. Prepare Amount
    const decimals = await usdtContract.decimals(); // USDT on BSC is 18
    const amountWei = ethers.parseUnits(DEPOSIT_AMOUNT_HUMAN, decimals);

    console.log(`Target: Deposit ${DEPOSIT_AMOUNT_HUMAN} USDT for ${BENEFICIARY}`);

    // 2. Check & Handle Allowance (Simulation + Call)
    const currentAllowance = await usdtContract.allowance(wallet.address, ASTERDEX_ADDRESS);
    console.log(`Current Allowance: ${ethers.formatUnits(currentAllowance, decimals)} USDT`);
    if (currentAllowance < amountWei) {
        console.log("Allowance low. Simulating Approval...");
        await usdtContract.approve.staticCall(ASTERDEX_ADDRESS, amountWei);

        console.log("Approval simulation passed. Sending transaction...");
        const approveTx = await usdtContract.approve(ASTERDEX_ADDRESS, amountWei);
        await approveTx.wait();
        console.log("Approval confirmed.");
    }

    // 3. Simulate depositFor
    console.log("Simulating depositFor...");
    try {
        await asterContract.depositFor.staticCall(
            USDT_ADDRESS,   // currency (token address)
            BENEFICIARY,    // forAddress
            amountWei,      // amount
            BROKER_ID       // broker
        );
        console.log("✅ Simulation successful! The transaction should succeed.");
    } catch (error: any) {
        const decoded = decodeContractError(error);
        console.error("❌ Simulation failed!");
        console.error("   Decoded Error:", decoded);
        return;
    }

    // 4. Actual Execution
    console.log("Sending depositFor transaction...");
    const tx = await asterContract.depositFor(
        USDT_ADDRESS,   // currency
        BENEFICIARY,    // forAddress
        amountWei,      // amount
        BROKER_ID,      // broker
        {
            gasLimit: 250000
        }
    );

    console.log(`Transaction Hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`Deposit confirmed in block ${receipt?.blockNumber}`);
}

main().catch(console.error);
