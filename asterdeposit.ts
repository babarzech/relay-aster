/**
 * asterMulticallDeposit.ts
 *
 * GOAL:
 *   Wallet1 (user) pays the USDT.
 *   Wallet2 (server) is credited on Aster — it is the depositor.
 *
 * HOW msg.sender WORKS WITH ASTER deposit():
 *   asterBridge.deposit(currency, amount, broker)
 *     → internally calls transferFrom(msg.sender, vault, amount)
 *     → credits msg.sender on Aster
 *   So whoever SENDS the deposit() tx gets credited.
 *   We want Wallet2 to send it → Wallet2 gets credited. ✓
 *
 * FLOW (3 pre-reqs, then 2 txs from Wallet2 only):
 *
 *   [Pre A] Wallet1 approves Multicall3 to spend its USDT  (1 tx from Wallet1)
 *   [Pre B] Wallet2 approves AsterBridge to spend its USDT (1 tx from Wallet2)
 *           (because after pull, USDT sits in Wallet2, and deposit() does
 *            transferFrom(Wallet2, vault) since Wallet2 sends deposit tx)
 *
 *   [Tx 1]  Wallet2 sends Multicall3.aggregate3([
 *               USDT.transferFrom(wallet1 → wallet2, amount)
 *           ])
 *           → USDT moves from Wallet1 to Wallet2. Wallet2 pays gas.
 *
 *   [Tx 2]  Wallet2 sends asterBridge.deposit(USDT, amount, brokerId)
 *           → Aster credits Wallet2. Wallet2 pays gas.
 *
 * RESULT: USDT came from Wallet1. Aster account credited = Wallet2. ✓
 *
 * NOTE: Pre A + Pre B are one-time approvals. After that only Tx1+Tx2 repeat per deposit.
 * Both pre-reqs are handled automatically in this script.
 *
 * Run: npx tsx asterMulticallDeposit.ts
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, ".env") });

// ─────────────────────────────────────────────
// CONFIGURATION ← only edit this section
// ─────────────────────────────────────────────
const RPC_URL = "https://bsc-dataseed.binance.org/";
const USDT_ADDRESS = "0x55d398326f99059ff775485246999027b3197955";
const ASTER_BRIDGE = "0x128463a60784c4d3f46c23af3f65ed859ba87974";
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const DEPOSIT_AMOUNT_HUMAN = "0.05";  // USDT to deposit
const BROKER_ID = "1000";

// Set in .env
const USER_WALLET_PK = process.env.PRIVATE_KEY!;           // Wallet1 — source of USDT
const SERVER_WALLET_PK = process.env.WALLET2_PRIVATE_KEY!;   // Wallet2 — credited on Aster

// ─────────────────────────────────────────────
// ABIs
// ─────────────────────────────────────────────
const USDT_ABI = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)",
];

const ASTER_ABI = [
    "function deposit(address currency, uint256 amount, uint256 broker) external",
];

const MULTICALL3_ABI = [
    `function aggregate3(
    tuple(address target, bool allowFailure, bytes callData)[] calls
  ) external payable returns (tuple(bool success, bytes returnData)[] returnData)`,
];

const ERROR_ABI = [
    "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
    "error CurrencyNotSupport(address currency)",
    "error ZeroAmount()",
    "error ValueNotZero()",
    "error AmountIllegal(uint256 supported, uint256 actual)",
    "error ZeroAddress()",
];

// ─────────────────────────────────────────────
// Error decoder (same as your working script)
// ─────────────────────────────────────────────
function decodeError(error: any): string {
    const data = error?.data || error?.info?.error?.data || error?.error?.data;
    if (!data || typeof data !== "string") {
        return error?.reason || error?.message || "Unknown error";
    }
    const iface = new ethers.Interface(ERROR_ABI);
    try {
        const decoded = iface.parseError(data);
        if (!decoded) return `Raw revert: ${data}`;
        switch (decoded.name) {
            case "AccessControlUnauthorizedAccount":
                return `AccessControl: wallet ${decoded.args[0]} missing role ${decoded.args[1]}`;
            case "CurrencyNotSupport":
                return `CurrencyNotSupport: token ${decoded.args[0]} not allowed by Aster`;
            case "ZeroAmount": return "ZeroAmount: amount cannot be zero";
            case "ValueNotZero": return "ValueNotZero: msg.value must be 0 for ERC-20";
            case "AmountIllegal": return `AmountIllegal: expected ${decoded.args[0]}, got ${decoded.args[1]}`;
            case "ZeroAddress": return "ZeroAddress: address param is zero";
            default: return `${decoded.name}(${decoded.args.join(", ")})`;
        }
    } catch {
        return `Raw revert: ${data}`;
    }
}

// ─────────────────────────────────────────────
// Helper: ensure allowance is set, approve if not
// ─────────────────────────────────────────────
async function ensureAllowance(
    label: string,
    usdtContract: ethers.Contract,
    owner: ethers.Wallet,
    spender: string,
    amount: bigint,
    decimals: number
) {
    const current = await usdtContract.allowance(owner.address, spender);
    console.log(`  ${label} allowance: ${ethers.formatUnits(current, decimals)} USDT`);
    if (current < amount) {
        console.log(`  Approving...`);
        const usdtSigned = usdtContract.connect(owner) as ethers.Contract;
        // Use MaxUint256 so this approval never needs repeating
        const tx = await usdtSigned.approve(spender, ethers.MaxUint256);
        console.log(`  approve tx: ${tx.hash}`);
        await tx.wait();
        console.log(`  ✓ Approved`);
    } else {
        console.log(`  ✓ Sufficient — skipping`);
    }
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
    if (!USER_WALLET_PK || !SERVER_WALLET_PK) {
        throw new Error("Set PRIVATE_KEY and WALLET2_PRIVATE_KEY in your .env file");
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const userWallet = new ethers.Wallet(USER_WALLET_PK, provider);   // Wallet1
    const serverWallet = new ethers.Wallet(SERVER_WALLET_PK, provider); // Wallet2

    console.log("══════════════════════════════════════════════════");
    console.log("Wallet1 (source of USDT) :", userWallet.address);
    console.log("Wallet2 (Aster account)  :", serverWallet.address);
    console.log("Aster Bridge             :", ASTER_BRIDGE);
    console.log("Deposit Amount           :", DEPOSIT_AMOUNT_HUMAN, "USDT");
    console.log("Broker ID                :", BROKER_ID);
    console.log("══════════════════════════════════════════════════\n");

    const usdtProvider = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);
    const usdtIface = new ethers.Interface(USDT_ABI);

    const decimals = await usdtProvider.decimals();

    const amount = ethers.parseUnits(DEPOSIT_AMOUNT_HUMAN, decimals);
    console.log(`USDT decimals: ${decimals}`);
    console.log(`Amount (wei) : ${amount.toString()}\n`);

    // ── Balance check ──
    const balance = await usdtProvider.balanceOf(userWallet.address);
    console.log(`Wallet1 USDT balance: ${ethers.formatUnits(balance, decimals)} USDT`);
    if (balance < amount) {
        throw new Error(
            `Wallet1 has insufficient USDT. Have ${ethers.formatUnits(balance, decimals)}, need ${DEPOSIT_AMOUNT_HUMAN}`
        );
    }

    // ════════════════════════════════════════════════════════════
    // PRE-REQ A: Wallet1 approves Multicall3
    //   Allows Multicall3 to call transferFrom(wallet1, wallet2, amount)
    //   This is the only tx Wallet1 ever needs to send (one-time).
    // ════════════════════════════════════════════════════════════
    console.log("[Pre A] Wallet1 → Multicall3 allowance:");
    await ensureAllowance(
        "Wallet1→Multicall3",
        usdtProvider,
        userWallet,
        MULTICALL3_ADDRESS,
        amount,
        decimals
    );
    console.log();

    // ════════════════════════════════════════════════════════════
    // PRE-REQ B: Wallet2 approves Aster Bridge
    //   After Tx1, USDT is in Wallet2.
    //   Wallet2 calls deposit() → Aster calls transferFrom(Wallet2, vault, amount)
    //   So Wallet2 must approve the bridge. (one-time, done here)
    // ════════════════════════════════════════════════════════════
    console.log("[Pre B] Wallet2 → AsterBridge allowance:");
    await ensureAllowance(
        "Wallet2→AsterBridge",
        usdtProvider,
        serverWallet,
        ASTER_BRIDGE,
        amount,
        decimals
    );
    console.log();

    // ════════════════════════════════════════════════════════════
    // TX 1: Wallet2 sends Multicall3 to pull USDT from Wallet1 → Wallet2
    //   msg.sender of transferFrom = Multicall3 (which has wallet1's allowance)
    //   USDT lands in Wallet2.
    //   Wallet2 pays the gas.
    // ════════════════════════════════════════════════════════════
    console.log("[Tx 1] Pull USDT from Wallet1 → Wallet2 via Multicall3...");

    const pullCalldata = usdtIface.encodeFunctionData("transferFrom", [
        userWallet.address,
        serverWallet.address,
        amount,
    ]);

    const pullCalls = [
        { target: USDT_ADDRESS, allowFailure: false, callData: pullCalldata },
    ];

    const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, serverWallet);

    // Simulate
    try {
        await multicall.aggregate3.staticCall(pullCalls);
        console.log("  ✓ Simulation passed");
    } catch (err: any) {
        console.error("  ✗ Simulation FAILED:", decodeError(err));
        console.error("    Raw:", err.message?.slice(0, 400));
        throw err;
    }

    const gasEst1 = await multicall.aggregate3.estimateGas(pullCalls);
    const gasLim1 = (gasEst1 * 130n) / 100n;

    const pullTx = await multicall.aggregate3(pullCalls, { gasLimit: gasLim1 });
    console.log("  tx hash:", pullTx.hash);
    await pullTx.wait();
    console.log("  ✓ USDT is now in Wallet2\n");

    // ════════════════════════════════════════════════════════════
    // TX 2: Wallet2 deposits to Aster
    //   msg.sender = Wallet2 → Aster credits Wallet2 ✓
    //   deposit() calls transferFrom(Wallet2, vault, amount) — uses Pre-req B allowance
    // ════════════════════════════════════════════════════════════
    console.log("[Tx 2] Wallet2 deposits to Aster...");

    const asterContract = new ethers.Contract(ASTER_BRIDGE, ASTER_ABI, serverWallet);

    // Simulate
    try {
        await asterContract.deposit.staticCall(USDT_ADDRESS, amount, BROKER_ID);
        console.log("  ✓ Simulation passed");
    } catch (err: any) {
        console.error("  ✗ Simulation FAILED:", decodeError(err));
        console.error("    Raw:", err.message?.slice(0, 400));
        throw err;
    }

    const depositTx = await asterContract.deposit(USDT_ADDRESS, amount, BROKER_ID, {
        gasLimit: 300000,
    });
    console.log("  tx hash:", depositTx.hash);
    const receipt = await depositTx.wait();

    console.log(`\n✅ DONE — confirmed in block ${receipt.blockNumber}`);
    console.log(`   USDT paid by Wallet1  : ${userWallet.address}`);
    console.log(`   Aster credits Wallet2 : ${serverWallet.address}`);
}

main().catch((e) => {
    console.error("\n❌ Error:", e.message ?? e);
    process.exit(1);
});