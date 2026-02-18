/**
 * multicall_deposit.ts
 * 
 * Multicall-style Aster deposit flow using TWO wallets:
 * 
 * Wallet 1 (Main MetaMask wallet) - holds the USDT, initiates the flow
 * Wallet 2 (Server/Agent wallet) - receives USDT then deposits to Aster on behalf of Wallet 1
 *
 * Flow:
 *   Step 1: Wallet 1 approves USDT spending for Wallet 2
 *   Step 2: Wallet 2 pulls USDT from Wallet 1 via transferFrom
 *   Step 3: Wallet 2 approves USDT to Aster contract (if needed)
 *   Step 4: Wallet 2 calls deposit() on Aster — the deposit is credited to Wallet 2's address
 *
 * NOTE: Since Aster's deposit() credits msg.sender, and depositFor() requires DEPOSIT_ROLE,
 *       the deposit will be credited to Wallet 2. If Wallet 2 has DEPOSIT_ROLE, you can use
 *       depositFor() to credit Wallet 1 instead. Set USE_DEPOSIT_FOR = true for that.
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, ".env") });

// ===================== CONFIGURATION =====================

const RPC_URL = "https://bsc-dataseed.binance.org/";

// Wallet 1: Main MetaMask wallet (holds the USDT)
const WALLET1_PRIVATE_KEY = process.env.PRIVATE_KEY!;

// Wallet 2: Server/Agent wallet (will do the deposit to Aster)
const WALLET2_PRIVATE_KEY = process.env.WALLET2_PRIVATE_KEY!;

// Contract addresses
const ASTER_VAULT_ADDRESS = "0x128463a60784c4d3f46c23af3f65ed859ba87974";
const USDT_ADDRESS = "0x55d398326f99059ff775485246999027b3197955";

// Deposit parameters
const DEPOSIT_AMOUNT_HUMAN = "0.05"; // 0.05 USDT
const BROKER_ID = "1000";

// Set to true if Wallet 2 has DEPOSIT_ROLE and you want the deposit
// credited to Wallet 1's address. Otherwise deposit credits Wallet 2.
const USE_DEPOSIT_FOR = false;

// ===================== ABIs =====================

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function transferFrom(address from, address to, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function balanceOf(address account) external view returns (uint256)",
    "function decimals() external view returns (uint8)",
];

const ASTER_ABI = [
    "function deposit(address currency, uint256 amount, uint256 broker) external",
    "function depositFor(address currency, address forAddress, uint256 amount, uint256 broker) external payable",
];

// Known custom errors from AstherusVault
const ERROR_ABI = [
    "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
    "error CurrencyNotSupport(address currency)",
    "error ZeroAmount()",
    "error ValueNotZero()",
    "error AmountIllegal(uint256 supported, uint256 actual)",
    "error ZeroAddress()",
];

// ===================== HELPERS =====================

function decodeContractError(error: any): string {
    const data = error?.data || error?.info?.error?.data || error?.error?.data;
    if (!data || typeof data !== "string") {
        return error.reason || error.shortMessage || error.message || "Unknown error";
    }
    const iface = new ethers.Interface(ERROR_ABI);
    try {
        const decoded = iface.parseError(data);
        if (!decoded) return `Raw revert data: ${data}`;
        switch (decoded.name) {
            case "AccessControlUnauthorizedAccount":
                return `AccessControlUnauthorizedAccount: wallet ${decoded.args[0]} missing required role`;
            case "CurrencyNotSupport":
                return `CurrencyNotSupport: token ${decoded.args[0]} is not supported`;
            case "ZeroAmount":
                return "ZeroAmount: deposit amount cannot be zero";
            case "ValueNotZero":
                return "ValueNotZero: msg.value must be 0 for ERC20 deposits";
            case "AmountIllegal":
                return `AmountIllegal: expected ${decoded.args[0]}, actual ${decoded.args[1]}`;
            case "ZeroAddress":
                return "ZeroAddress: an address cannot be zero";
            default:
                return `${decoded.name}(${decoded.args.join(", ")})`;
        }
    } catch {
        return `Raw revert data: ${data}`;
    }
}

// ===================== MAIN FLOW =====================

async function main() {
    // --- Validate keys ---
    if (!WALLET1_PRIVATE_KEY) {
        console.error("❌ PRIVATE_KEY not set in .env (Wallet 1 / MetaMask)");
        process.exit(1);
    }
    if (!WALLET2_PRIVATE_KEY) {
        console.error("❌ WALLET2_PRIVATE_KEY not set in .env (Wallet 2 / Server)");
        process.exit(1);
    }

    // --- Connect wallets ---
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet1 = new ethers.Wallet(WALLET1_PRIVATE_KEY, provider);
    const wallet2 = new ethers.Wallet(WALLET2_PRIVATE_KEY, provider);

    console.log("=== Multicall Aster Deposit ===");
    console.log(`Wallet 1 (Main/MetaMask): ${wallet1.address}`);
    console.log(`Wallet 2 (Server/Agent):  ${wallet2.address}`);
    console.log();

    // --- Contracts ---
    const usdtWallet1 = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet1);
    const usdtWallet2 = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet2);
    const asterWallet2 = new ethers.Contract(ASTER_VAULT_ADDRESS, ASTER_ABI, wallet2);

    // --- Prepare amount ---
    const decimals = await usdtWallet1.decimals();
    const amountWei = ethers.parseUnits(DEPOSIT_AMOUNT_HUMAN, decimals);
    console.log(`Deposit Amount: ${DEPOSIT_AMOUNT_HUMAN} USDT (${amountWei} wei, ${decimals} decimals)`);

    // --- Check Wallet 1 balance ---
    const wallet1Balance = await usdtWallet1.balanceOf(wallet1.address);
    console.log(`Wallet 1 USDT Balance: ${ethers.formatUnits(wallet1Balance, decimals)}`);
    if (wallet1Balance < amountWei) {
        console.error("❌ Wallet 1 does not have enough USDT!");
        return;
    }

    // =========================================================
    // STEP 0: Fund Wallet 2 with BNB for gas (if needed)
    // =========================================================
    const MIN_GAS_BNB = ethers.parseEther("0.002"); // ~enough for 3 txs
    const wallet2BnbBalance = await provider.getBalance(wallet2.address);
    console.log(`\nWallet 2 BNB Balance: ${ethers.formatEther(wallet2BnbBalance)} BNB`);

    if (wallet2BnbBalance < MIN_GAS_BNB) {
        const fundAmount = ethers.parseEther("0.003"); // send a bit more for safety
        console.log(`--- Step 0: Funding Wallet 2 with ${ethers.formatEther(fundAmount)} BNB for gas ---`);
        const fundTx = await wallet1.sendTransaction({
            to: wallet2.address,
            value: fundAmount,
        });
        console.log(`Fund tx: ${fundTx.hash}`);
        await fundTx.wait();
        console.log("✅ Wallet 2 funded with BNB.");
    } else {
        console.log("✅ Wallet 2 has enough BNB for gas.");
    }

    // =========================================================
    // STEP 1: Wallet 1 approves Wallet 2 to spend its USDT
    // =========================================================
    console.log("\n--- Step 1: Wallet 1 approves Wallet 2 ---");
    const currentAllowance = await usdtWallet1.allowance(wallet1.address, wallet2.address);
    console.log(`Current allowance (Wallet1 → Wallet2): ${ethers.formatUnits(currentAllowance, decimals)} USDT`);

    if (currentAllowance < amountWei) {
        console.log("Approving Wallet 2 to spend USDT...");
        const approveTx = await usdtWallet1.approve(wallet2.address, amountWei);
        console.log(`Approval tx: ${approveTx.hash}`);
        await approveTx.wait();
        console.log("✅ Approval confirmed.");
    } else {
        console.log("✅ Allowance already sufficient.");
    }

    // =========================================================
    // STEP 2: Wallet 2 pulls USDT from Wallet 1 via transferFrom
    // =========================================================
    console.log("\n--- Step 2: Wallet 2 pulls USDT from Wallet 1 ---");
    const transferTx = await usdtWallet2.transferFrom(wallet1.address, wallet2.address, amountWei);
    console.log(`TransferFrom tx: ${transferTx.hash}`);
    await transferTx.wait();
    console.log("✅ USDT transferred to Wallet 2.");

    // =========================================================
    // STEP 3: Wallet 2 approves Aster to spend USDT (if needed)
    // =========================================================
    console.log("\n--- Step 3: Wallet 2 approves Aster contract ---");
    const asterAllowance = await usdtWallet2.allowance(wallet2.address, ASTER_VAULT_ADDRESS);
    console.log(`Current allowance (Wallet2 → Aster): ${ethers.formatUnits(asterAllowance, decimals)} USDT`);

    if (asterAllowance < amountWei) {
        console.log("Approving Aster contract...");
        const approveTx = await usdtWallet2.approve(ASTER_VAULT_ADDRESS, ethers.MaxUint256);
        console.log(`Approval tx: ${approveTx.hash}`);
        await approveTx.wait();
        console.log("✅ Aster approval confirmed.");
    } else {
        console.log("✅ Aster allowance already sufficient.");
    }

    // =========================================================
    // STEP 4: Wallet 2 deposits USDT into Aster
    // =========================================================
    if (USE_DEPOSIT_FOR) {
        // depositFor: credits Wallet 1's address (requires DEPOSIT_ROLE)
        console.log(`\n--- Step 4: Wallet 2 calls depositFor (crediting Wallet 1: ${wallet1.address}) ---`);

        // Simulate
        console.log("Simulating depositFor...");
        try {
            await asterWallet2.depositFor.staticCall(USDT_ADDRESS, wallet1.address, amountWei, BROKER_ID);
            console.log("✅ Simulation passed!");
        } catch (error: any) {
            console.error("❌ Simulation failed:", decodeContractError(error));
            return;
        }

        // Execute
        const tx = await asterWallet2.depositFor(USDT_ADDRESS, wallet1.address, amountWei, BROKER_ID, {
            gasLimit: 300000,
        });
        console.log(`Transaction: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`✅ depositFor confirmed in block ${receipt?.blockNumber}`);
    } else {
        // deposit: credits Wallet 2's address (no role needed)
        console.log(`\n--- Step 4: Wallet 2 calls deposit (credited to Wallet 2: ${wallet2.address}) ---`);

        // Simulate
        console.log("Simulating deposit...");
        try {
            await asterWallet2.deposit.staticCall(USDT_ADDRESS, amountWei, BROKER_ID);
            console.log("✅ Simulation passed!");
        } catch (error: any) {
            console.error("❌ Simulation failed:", decodeContractError(error));
            return;
        }

        // Execute
        const tx = await asterWallet2.deposit(USDT_ADDRESS, amountWei, BROKER_ID, {
            gasLimit: 300000,
        });
        console.log(`Transaction: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`✅ Deposit confirmed in block ${receipt?.blockNumber}`);
    }

    console.log("\n=== DONE ===");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
