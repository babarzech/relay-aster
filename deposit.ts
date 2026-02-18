import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, ".env") });

// --- CONFIGURATION ---
const RPC_URL = "https://bsc-dataseed.binance.org/";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ASTERDEX_ADDRESS = "0x128463a60784c4d3f46c23af3f65ed859ba87974";
const USDT_ADDRESS = "0x55d398326f99059ff775485246999027b3197955";

const DEPOSIT_AMOUNT_HUMAN = "0.05"; // 0.05 USDT
const BROKER_ID = "1000";

// ABIs
const ASTERDEX_ABI = [
    "function deposit(address currency, uint256 amount, uint256 broker) external"
];
const ERC20_ABI = [
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function allowance(address owner, address spender) public view returns (uint256)",
    "function decimals() public view returns (uint8)"
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

function decodeContractError(error: any): string {
    const data = error?.data || error?.info?.error?.data || error?.error?.data;
    if (!data || typeof data !== "string") {
        return error.reason || error.message || "Unknown error";
    }
    const iface = new ethers.Interface(ERROR_ABI);
    try {
        const decoded = iface.parseError(data);
        if (!decoded) return `Raw revert data: ${data}`;
        switch (decoded.name) {
            case "AccessControlUnauthorizedAccount":
                return `AccessControlUnauthorizedAccount: wallet ${decoded.args[0]} missing role ${decoded.args[1]}`;
            case "CurrencyNotSupport":
                return `CurrencyNotSupport: token ${decoded.args[0]} is not supported.`;
            case "ZeroAmount":
                return `ZeroAmount: deposit amount cannot be zero.`;
            case "ValueNotZero":
                return `ValueNotZero: msg.value must be 0 for ERC20 deposits.`;
            case "AmountIllegal":
                return `AmountIllegal: expected ${decoded.args[0]}, actual ${decoded.args[1]}.`;
            case "ZeroAddress":
                return `ZeroAddress: address cannot be zero.`;
            default:
                return `${decoded.name}(${decoded.args.join(", ")})`;
        }
    } catch {
        return `Raw revert data: ${data}`;
    }
}

async function main() {
    if (!PRIVATE_KEY) {
        console.error("Please set PRIVATE_KEY in your .env file");
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    console.log(`Wallet: ${wallet.address}`);

    const asterContract = new ethers.Contract(ASTERDEX_ADDRESS, ASTERDEX_ABI, wallet);
    const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet);

    // 1. Prepare Amount
    const decimals = await usdtContract.decimals();
    const amountWei = ethers.parseUnits(DEPOSIT_AMOUNT_HUMAN, decimals);
    console.log(`Depositing ${DEPOSIT_AMOUNT_HUMAN} USDT (${amountWei} wei, ${decimals} decimals)`);

    // 2. Check & Handle Allowance
    const currentAllowance = await usdtContract.allowance(wallet.address, ASTERDEX_ADDRESS);
    console.log(`Current Allowance: ${ethers.formatUnits(currentAllowance, decimals)} USDT`);

    if (currentAllowance < amountWei) {
        console.log("Approving USDT...");
        const approveTx = await usdtContract.approve(ASTERDEX_ADDRESS, amountWei);
        console.log(`Approval tx: ${approveTx.hash}`);
        await approveTx.wait();
        console.log("Approval confirmed.");
    }

    // 3. Simulate deposit
    console.log("Simulating deposit...");
    try {
        await asterContract.deposit.staticCall(USDT_ADDRESS, amountWei, BROKER_ID);
        console.log("✅ Simulation successful!");
    } catch (error: any) {
        console.error("❌ Simulation failed!");
        console.error("   Error:", decodeContractError(error));
        return;
    }

    // 4. Send actual transaction
    console.log("Sending deposit transaction...");
    const tx = await asterContract.deposit(USDT_ADDRESS, amountWei, BROKER_ID, {
        gasLimit: 250000,
    });

    console.log(`Transaction Hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Deposit confirmed in block ${receipt?.blockNumber}`);
}

main().catch(console.error);
