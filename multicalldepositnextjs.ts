// batchedDeposit.tsx (React + wagmi, TypeScript)
import { useEffect, useRef, useState } from "react";
import {
    batchedDepositWithPermitAbi,
    multicallAbi,
    PermitAndTransferFrom,
} from "./abi"; // your ABI for batchedDepositWithPermit

import {
    AGREGATOR,
    getwltConfig,
    USDC_CONTRACT,
} from "@/app/helpers/auth/wallet-config";
import { IApiResponse, IChainInfo } from "@/app/helpers/interfaces";
import { usePermitNonce } from "./nonce_reader";
// import { preventExtraNumber } from "@/app/helpers/common";
import { toast } from "sonner";
// import ButtonPrimarFill from "@/app/components/button";
// import { InputWithAddon } from "@/app/components/ui/input";
import { WalletService } from "@/app/helpers/user/wallet-service";
import {
    BRIDGE,
    ethers,
    Interface,
    JsonRpcProvider,
    parseUnits,
    Signature,

    Wallet,
} from "@/app/components/metamask/hooks/evm-wallet-hook";
import { useWalletProvider } from "@/app/components/metamask/hooks/wallet-hook-provider";
// import SpiningLoader from "@/app/components/spiningLoader";

// export address = address
export interface Props {
    address: `0x${string}`;
    selectedNetwork: IChainInfo | null;
    // fullWidth: boolean;
    // onClose: (status: boolean) => void;
}

const bridgeAbi = batchedDepositWithPermitAbi;

export default function useDirectDeposit({
    address,
    selectedNetwork,
    // fullWidth,
    // onClose,
}: Props) {
    const {
        useAccountHook,
        useChainData,
        usePerMitHandler,
        useReadContractData,
        useWalletHook } = useWalletProvider()
    const { address: ownerAddress } = useAccountHook();
    const [loading, setLoading] = useState(false);
    const {
        writeContractAsync,
        publicClient,
    } = useWalletHook();
    const noncehandler = usePermitNonce();
    // const [amount, setAmount] = useState<string>("");
    const aggregatorPK = AGREGATOR;
    const { activeChainId, switchChainAsync, formatUnits } = useChainData();
    const requiredChainId = getwltConfig().chainId; // Arbitrum Sepolia testnet
    // const {, JsonRpcProvider, Wallet} = useEthersHook()
    const provderref = useRef<ethers.JsonRpcProvider | null>(null);
    const aggregatorWallet = useRef<ethers.Wallet | null>(null);

    useEffect(() => {
        provderref.current = new JsonRpcProvider(
            getwltConfig().rpc
        );
        // assert provider is not null when passing to Wallet constructor
        aggregatorWallet.current = new Wallet(aggregatorPK, provderref.current!);
        // const wlt = new Wallet(aggregatorPK, provderref.current!);
    }, []);

    const { decimalsData, balanceData } = useReadContractData({
        contract_Address: USDC_CONTRACT,
    });
    const decimals = decimalsData ? Number(decimalsData) : 6;

    const formattedBalance = balanceData
        ? Number(formatUnits(balanceData as bigint, Number(decimalsData)))
        : 0;
    // const publicClient = usePublicClient(); // for estimateGas
    //   const network = useNetwork();

    // const { data: gasEstimate, error, isLoading, status } = useEstimateGas();

    // helper: build the EIP-712 domain & data exactly like docs
    const { signPermit } = usePerMitHandler();

    async function onSubmitDeposit(amount: string) {
        if (selectedNetwork === null) {
            toast.info("Please select the valid networ");
            return;
        }
        if (!ownerAddress || !publicClient) {
            toast.info("Wallet is not connected Please connect the wallet");
            return;
        }
        if ((address as string) === "") {
            toast.info(
                "Deposit address not generated please contact site administrator"
            );
            return;
        }
        if (amount === "" || isNaN(Number(amount))) {
            toast.info("please enter valid amount");
            return;
        }
        if (Number(amount) < (selectedNetwork.minDeposit ?? 0)) {
            toast.info(
                `Minimum deposit allowed is ${selectedNetwork.minDeposit ?? 0} USDC`
            );
            return;
        }
        if (Number(amount) > formattedBalance) {
            toast.info("Not enogh balance");
            return;
        }
        setLoading(true);
        if (activeChainId !== requiredChainId) {
            await switchChainAsync({ chainId: requiredChainId });
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        try {
            // --- PREPARATION ---
            const chainId = await publicClient?.getChainId();
            // const amountinEther = Number(amount) * Math.pow(10, 6);
            const amountinEther = parseUnits(amount, decimals);
            const usdAmount = BigInt(amountinEther);
            const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
            const multicallAddress = getwltConfig().multicall as `0x${string}`;
            const tokenAddress = USDC_CONTRACT as `0x${string}`;

            // --- NONCE ---
            // Use publicClient (Viem) to get nonce to ensure it works with the chain state
            // Or keep your noncehandler if it returns a NUMBER, convert to BigInt
            // const nonce = await publicClient.readContract({
            //     address: tokenAddress,
            //     abi: parseAbi(['function nonces(address) view returns (uint256)']),
            //     functionName: 'nonces',
            //     args: [ownerAddress]
            // });
            const rawNonce = await noncehandler.getNonce(
                USDC_CONTRACT as `0x${string}`
            );
            const nonce = BigInt(rawNonce);

            // --- STEP 1: SIGN PERMIT ---
            const sig = await signPermit({
                owner: ownerAddress,
                spender: multicallAddress, // MUST BE MULTICALL ADDRESS
                value: usdAmount,
                nonce: nonce,
                deadline: deadline,
                chainId: chainId!, // default to Arbitrum Sepolia
            });

            // --- ENCODING (You can keep Ethers Interface here, it works fine) ---
            const tokenInterface = new Interface(PermitAndTransferFrom);
            const bridgeInterface = new Interface(bridgeAbi);
            const multicallInterface = new Interface(multicallAbi);

            // 1. Permit Calldata
            const step1CallData = tokenInterface.encodeFunctionData("permit", [
                ownerAddress,
                multicallAddress,
                usdAmount,
                deadline,
                sig.v,
                sig.r,
                sig.s,
            ]) as `0x${string}`; // Cast to Viem type
            // 2. TransferFrom Calldata
            const step2CallData = tokenInterface.encodeFunctionData("transferFrom", [
                ownerAddress,
                address, // Sending to Aggregator wallet
                usdAmount,
            ]) as `0x${string}`;
            const res: IApiResponse =
                await WalletService.getInstance().getPermitSignature({
                    Amount: Number(amountinEther),
                });
            const ressigBackend = res.Result?.[0];
            const deadlineBackend = res.Result?.[1];

            const signatureToSend = Signature.from(ressigBackend);
            const deposits1 = [
                {
                    user: address,
                    usd: usdAmount,
                    deadline: deadlineBackend,
                    signature: {
                        r: signatureToSend.r,
                        s: signatureToSend.s,
                        v: signatureToSend.v,
                    },
                },
            ];
            const step3CallData = bridgeInterface.encodeFunctionData(
                "batchedDepositWithPermit",
                [deposits1]
            ) as `0x${string}`;
            // --- CONSTRUCT MULTICALL ARRAY ---
            const calls = [
                {
                    target: tokenAddress,
                    allowFailure: false,
                    callData: step1CallData,
                },
                {
                    target: tokenAddress,
                    allowFailure: false,
                    callData: step2CallData,
                },
                {
                    target: BRIDGE as `0x${string}`,
                    allowFailure: false,
                    callData: step3CallData,
                },
            ];
            const multicallData = multicallInterface.encodeFunctionData(
                "aggregate3",
                [calls]
            );

            // --- GAS ESTIMATION (CORRECTED) ---
            // You must estimate on the MULTICALL contract, passing the 'calls' array
            let gasLimit = BigInt(3000000); // Default safe limit
            try {
                const estimated = await publicClient?.estimateContractGas({
                    address: multicallAddress,
                    abi: multicallAbi,
                    functionName: "aggregate3",
                    args: [calls], // Pass array inside array
                    account: ownerAddress,
                });
                gasLimit = ((estimated ?? BigInt(0)) * BigInt(120)) / BigInt(100); // +20% buffer
            } catch (e) {
                setLoading(false);

                console.warn(
                    "Gas estimation failed (simulation error), using fallback.",
                    e
                );
                // Simulation might fail if the Token Permit signature is invalid for some reason
                // or if the Backend Aggregator signature is invalid.
            }

            let request;
            try {
                const simulationResult = await publicClient?.simulateContract({
                    address: multicallAddress,
                    abi: multicallAbi,
                    functionName: "aggregate3",
                    args: [calls],
                    account: ownerAddress,
                    // Optional: Add value if the transaction requires ETH, e.g., value: 0n
                });

                // If simulation succeeds, we get the request object ready for writing
                request = simulationResult?.request;
            } catch (simError) {
                const message = simError instanceof Error ? simError.message : "Unknown error";
                console.error("Simulation Failed:", simError);

                // Extract a readable error message if possible
                const errorMessage =
                    message ||
                    "Transaction simulation failed";

                toast.error(`Error: ${errorMessage}`);
                setLoading(false);
                return; // STOP execution here if simulation fails
            }
            // --- EXECUTE TRANSACTION ---
            const hash = await writeContractAsync({
                address: multicallAddress,
                abi: multicallAbi,
                functionName: "aggregate3",
                args: [calls],
                gas: gasLimit,
            });
            toast.success("Transaction successfull");
            // onClose(false);
            setLoading(false);
        } catch (err) {
            setLoading(false);
            console.error("Transaction Error:", err);
            toast.error("Transaction Failed");
        }
    }

    // const handlekeyPress = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    //   preventExtraNumber(Number(amount), 2, ev);
    // };
    return {
        onSubmitDeposit
    }
    // <div>
    {/* <div
        className={`relative w-full ${fullWidth ? "max-w-[100%]" : "max-w-[80%]"
          }`}
      >
        <InputWithAddon
          placeholder="Amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onRightLabelClick={() =>
            setAmount(String(Number(formattedBalance)?.toFixedFloor(2) || 0))
          }
          onKeyDown={(ev) => handlekeyPress(ev)}
          rightLabel={`MAX: ${String(Number(formattedBalance)?.toFixedFloor(2)) || 0
            }`}
          adjustRightLineClass=" hidden"
          rightLabelClassName="w-auto"
        />
      </div>
      <ButtonPrimarFill
        className="h-[40px] w-full mt-2 mb-2"
        onClick={onSubmitDeposit}
      >
        {loading ? <SpiningLoader /> : "Deposit using wallet"}
      </ButtonPrimarFill>
      <button onClick={onSubmitDeposit}>Direct Deposit</button> */}
    // </div>
    // );
}

/**
 * Standalone function to generate address and perform deposit
 * Can be called from any component by just passing the amount
 * 
 * @param amount - The amount to deposit (as string)
 * @returns Promise<void>
 */
export async function depositWithAutoGeneratedAddress(amount: string): Promise<void> {
    try {
        // Step 1: Generate Address
        toast.info("Generating deposit address...");

        const modal = {
            CurrencyId: 4,
            ChainId: 34
        };

        const response = await WalletService.getInstance().generateAddress(modal);

        if (!response.Status || !response.Result?.[0]) {
            toast.error("Failed to generate deposit address");
            return;
        }

        const depositAddress = response.Result[0].Address!;
        const memo = response.Result[0].Memo || "";


        toast.success("Address generated successfully!");

        // Step 2: Perform Deposit using the generated address
        // Note: This requires the hooks and state from the component context
        // So we need to pass the deposit logic as a callback or use it within a component

        toast.info("Initiating deposit transaction...");

        // You'll need to call the actual deposit function here
        // Since this is outside the hook context, you might need to restructure
        // this to work within a component or pass necessary dependencies


    } catch (error) {
        console.error("Error in depositWithAutoGeneratedAddress:", error);
        toast.error("Failed to process deposit");
    }
}

/**
 * Hook version that can be used within components
 * Usage: const { depositWithAutoAddress } = useAutoDeposit();
 */
export function useAutoDeposit() {
    const {
        useAccountHook,
        useChainData,
        usePerMitHandler,
        useReadContractData,
        useWalletHook
    } = useWalletProvider();

    const { address: ownerAddress } = useAccountHook();
    const { writeContractAsync, publicClient } = useWalletHook();
    const noncehandler = usePermitNonce();
    const { activeChainId, switchChainAsync, formatUnits } = useChainData();
    const { signPermit } = usePerMitHandler();

    const requiredChainId = getwltConfig().chainId;
    const provderref = useRef<ethers.JsonRpcProvider | null>(null);
    const aggregatorWallet = useRef<ethers.Wallet | null>(null);
    const aggregatorPK = AGREGATOR;

    useEffect(() => {
        provderref.current = new JsonRpcProvider(getwltConfig().rpc);
        aggregatorWallet.current = new Wallet(aggregatorPK, provderref.current!);
    }, []);

    const { decimalsData, balanceData } = useReadContractData({
        contract_Address: USDC_CONTRACT,
    });

    const decimals = decimalsData ? Number(decimalsData) : 6;
    const formattedBalance = balanceData
        ? Number(formatUnits(balanceData as bigint, Number(decimalsData)))
        : 0;

    const depositWithAutoAddress = async (amount: string) => {
        try {
            // Validation
            if (!ownerAddress || !publicClient) {
                toast.error("Wallet is not connected. Please connect your wallet");
                return;
            }

            if (amount === "" || isNaN(Number(amount))) {
                toast.error("Please enter a valid amount");
                return;
            }

            if (Number(amount) > formattedBalance) {
                toast.error("Insufficient balance");
                return;
            }

            toast.info("Generating deposit address...");

            // Step 1: Generate Address
            const modal = {
                CurrencyId: 7,
                ChainId: 34
            };

            const response = await WalletService.getInstance().generateAddress(modal);

            if (!response.Status || !response.Result?.[0]) {
                toast.error("Failed to generate deposit address");
                return;
            }

            const depositAddress = response.Result[0].Address! as `0x${string}`;
            const memo = response.Result[0].Memo || "";


            toast.success("Address generated! Initiating deposit...");

            // Step 2: Switch chain if needed
            if (activeChainId !== requiredChainId) {
                await switchChainAsync({ chainId: requiredChainId });
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }

            // Step 3: Perform Deposit
            const chainId = await publicClient?.getChainId();
            const amountinEther = parseUnits(amount, decimals);
            const usdAmount = BigInt(amountinEther);
            const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
            const multicallAddress = getwltConfig().multicall as `0x${string}`;
            const tokenAddress = USDC_CONTRACT as `0x${string}`;

            // Get nonce
            const rawNonce = await noncehandler.getNonce(USDC_CONTRACT as `0x${string}`);
            const nonce = BigInt(rawNonce);

            // Sign permit
            const sig = await signPermit({
                owner: ownerAddress,
                spender: multicallAddress,
                value: usdAmount,
                nonce: nonce,
                deadline: deadline,
                chainId: chainId!,
            });

            // Encode calldata
            const tokenInterface = new Interface(PermitAndTransferFrom);
            const bridgeInterface = new Interface(batchedDepositWithPermitAbi);
            const multicallInterface = new Interface(multicallAbi);

            const step1CallData = tokenInterface.encodeFunctionData("permit", [
                ownerAddress,
                multicallAddress,
                usdAmount,
                deadline,
                sig.v,
                sig.r,
                sig.s,
            ]) as `0x${string}`;

            const step2CallData = tokenInterface.encodeFunctionData("transferFrom", [
                ownerAddress,
                depositAddress,
                usdAmount,
            ]) as `0x${string}`;

            const res: IApiResponse = await WalletService.getInstance().getPermitSignature({
                Amount: Number(amountinEther),
            });

            const ressigBackend = res.Result?.[0];
            const deadlineBackend = res.Result?.[1];
            const signatureToSend = Signature.from(ressigBackend);

            const deposits1 = [
                {
                    user: depositAddress,
                    usd: usdAmount,
                    deadline: deadlineBackend,
                    signature: {
                        r: signatureToSend.r,
                        s: signatureToSend.s,
                        v: signatureToSend.v,
                    },
                },
            ];

            const step3CallData = bridgeInterface.encodeFunctionData(
                "batchedDepositWithPermit",
                [deposits1]
            ) as `0x${string}`;

            const calls = [
                { target: tokenAddress, allowFailure: false, callData: step1CallData },
                { target: tokenAddress, allowFailure: false, callData: step2CallData },
                { target: BRIDGE as `0x${string}`, allowFailure: false, callData: step3CallData },
            ];

            // Gas estimation
            let gasLimit = BigInt(3000000);
            try {
                const estimated = await publicClient?.estimateContractGas({
                    address: multicallAddress,
                    abi: multicallAbi,
                    functionName: "aggregate3",
                    args: [calls],
                    account: ownerAddress,
                });
                gasLimit = ((estimated ?? BigInt(0)) * BigInt(120)) / BigInt(100);
            } catch (e) {
                console.warn("Gas estimation failed, using fallback", e);
            }

            // Simulate
            try {
                await publicClient?.simulateContract({
                    address: multicallAddress,
                    abi: multicallAbi,
                    functionName: "aggregate3",
                    args: [calls],
                    account: ownerAddress,
                });
            } catch (simError) {
                const message = simError instanceof Error ? simError.message : "Unknown error";
                toast.error(`Simulation failed: ${message}`);
                return;
            }

            // Execute
            const hash = await writeContractAsync({
                address: multicallAddress,
                abi: multicallAbi,
                functionName: "aggregate3",
                args: [calls],
                gas: gasLimit,
            });

            toast.success(`Deposit successful! Tx: ${hash}`);

        } catch (error) {
            console.error("Deposit Error:", error);
            toast.error("Deposit failed");
        }
    };

    return { depositWithAutoAddress, formattedBalance };
}