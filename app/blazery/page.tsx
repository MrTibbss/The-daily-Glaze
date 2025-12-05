"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sdk } from "@farcaster/miniapp-sdk";
import {
  useAccount,
  useConnect,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
  useSimulateContract,
} from "wagmi";
import { base } from "wagmi/chains";
import { formatEther, formatUnits, zeroAddress, type Address, maxUint256 } from "viem";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CONTRACT_ADDRESSES, MULTICALL_ABI } from "@/lib/contracts";
import { cn, getEthPrice } from "@/lib/utils";
import { NavBar } from "@/components/nav-bar";

type MiniAppContext = {
  user?: {
    fid: number;
    username?: string;
    displayName?: string;
    pfpUrl?: string;
  };
};

type AuctionState = {
  epochId: bigint | number;
  initPrice: bigint;
  startTime: bigint | number;
  paymentToken: Address;
  price: bigint;
  paymentTokenPrice: bigint;
  wethAccumulated: bigint;
  wethBalance: bigint;
  paymentTokenBalance: bigint;
};

const DEADLINE_BUFFER_SECONDS = 5 * 60;
const LP_TOKEN_ADDRESS = "0xD1DbB2E56533C55C3A637D13C53aeEf65c5D5703" as Address;

const toBigInt = (value: bigint | number) =>
  typeof value === "bigint" ? value : BigInt(value);

const formatEth = (value: bigint, maximumFractionDigits = 4) => {
  if (value === 0n) return "0";
  const asNumber = Number(formatEther(value));
  if (!Number.isFinite(asNumber)) {
    return formatEther(value);
  }
  return asNumber.toLocaleString(undefined, {
    maximumFractionDigits,
  });
};

const initialsFrom = (label?: string) => {
  if (!label) return "";
  const stripped = label.replace(/[^a-zA-Z0-9]/g, "");
  if (!stripped) return label.slice(0, 2).toUpperCase();
  return stripped.slice(0, 2).toUpperCase();
};

export default function BlazeryPage() {
  const readyRef = useRef(false);
  const autoConnectAttempted = useRef(false);
  const [context, setContext] = useState<MiniAppContext | null>(null);
  const [ethUsdPrice, setEthUsdPrice] = useState<number>(3500);
  const [blazeResult, setBlazeResult] = useState<"success" | "failure" | null>(
    null,
  );
  const [txStep, setTxStep] = useState<"idle" | "approving" | "buying">("idle");
  const blazeResultTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const resetBlazeResult = useCallback(() => {
    if (blazeResultTimeoutRef.current) {
      clearTimeout(blazeResultTimeoutRef.current);
      blazeResultTimeoutRef.current = null;
    }
    setBlazeResult(null);
  }, []);

  const showBlazeResult = useCallback(
    (result: "success" | "failure") => {
      if (blazeResultTimeoutRef.current) {
        clearTimeout(blazeResultTimeoutRef.current);
      }
      setBlazeResult(result);
      blazeResultTimeoutRef.current = setTimeout(() => {
        setBlazeResult(null);
        blazeResultTimeoutRef.current = null;
      }, 3000);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const hydrateContext = async () => {
      try {
        const ctx = (await (sdk as unknown as {
          context: Promise<MiniAppContext> | MiniAppContext;
        }).context) as MiniAppContext;
        if (!cancelled) {
          setContext(ctx);
        }
      } catch {
        if (!cancelled) setContext(null);
      }
    };
    hydrateContext();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch ETH price on mount and every minute
  useEffect(() => {
    const fetchPrice = async () => {
      const price = await getEthPrice();
      setEthUsdPrice(price);
    };

    fetchPrice();
    const interval = setInterval(fetchPrice, 60_000); // Update every minute

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    return () => {
      if (blazeResultTimeoutRef.current) {
        clearTimeout(blazeResultTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!readyRef.current) {
        readyRef.current = true;
        sdk.actions.ready().catch(() => {});
      }
    }, 1200);
    return () => clearTimeout(timeout);
  }, []);

  const { address, isConnected } = useAccount();
  const { connectors, connectAsync, isPending: isConnecting } = useConnect();
  const primaryConnector = connectors[0];

  useEffect(() => {
    if (
      autoConnectAttempted.current ||
      isConnected ||
      !primaryConnector ||
      isConnecting
    ) {
      return;
    }
    autoConnectAttempted.current = true;
    connectAsync({
      connector: primaryConnector,
      chainId: base.id,
    }).catch(() => {});
  }, [connectAsync, isConnected, isConnecting, primaryConnector]);

  const { data: rawAuctionState, refetch: refetchAuctionState } =
    useReadContract({
      address: CONTRACT_ADDRESSES.multicall,
      abi: MULTICALL_ABI,
      functionName: "getAuction",
      args: [address ?? zeroAddress],
      chainId: base.id,
      query: {
        refetchInterval: 3_000,
      },
    });

  const auctionState = useMemo(() => {
    if (!rawAuctionState) return undefined;
    return rawAuctionState as unknown as AuctionState;
  }, [rawAuctionState]);

  const ERC20_ABI = [
    {
      inputs: [
        { internalType: "address", name: "spender", type: "address" },
        { internalType: "uint256", name: "amount", type: "uint256" },
      ],
      name: "approve",
      outputs: [{ internalType: "bool", name: "", type: "bool" }],
      stateMutability: "nonpayable",
      type: "function",
    },
  ] as const;

  useEffect(() => {
    if (!readyRef.current && auctionState) {
      readyRef.current = true;
      sdk.actions.ready().catch(() => {});
    }
  }, [auctionState]);

  const {
    data: txHash,
    writeContract,
    isPending: isWriting,
    reset: resetWrite,
  } = useWriteContract();

  const { data: receipt, isLoading: isConfirming } =
    useWaitForTransactionReceipt({
      hash: txHash,
      chainId: base.id,
    });

  const handleBlaze = useCallback(async () => {
    if (!auctionState) return;
    resetBlazeResult();
    try {
      let targetAddress = address;
      if (!targetAddress) {
        if (!primaryConnector) {
          throw new Error("Wallet connector not available yet.");
        }
        const result = await connectAsync({
          connector: primaryConnector,
          chainId: base.id,
        });
        targetAddress = result.accounts[0];
      }
      if (!targetAddress) {
        throw new Error("Unable to determine wallet address.");
      }

      const price = auctionState.price;
      const epochId = toBigInt(auctionState.epochId);
      const deadline = BigInt(
        Math.floor(Date.now() / 1000) + DEADLINE_BUFFER_SECONDS,
      );
      const maxPaymentTokenAmount = price;

      // If we're in idle or approval failed, start with approval
      if (txStep === "idle") {
        setTxStep("approving");
        await writeContract({
          account: targetAddress as Address,
          address: LP_TOKEN_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [CONTRACT_ADDRESSES.multicall as Address, price],
          chainId: base.id,
        });
        return;
      }

      // If approval succeeded, now call buy
      if (txStep === "buying") {
        await writeContract({
          account: targetAddress as Address,
          address: CONTRACT_ADDRESSES.multicall as Address,
          abi: MULTICALL_ABI,
          functionName: "buy",
          args: [epochId, deadline, maxPaymentTokenAmount],
          chainId: base.id,
        });
      }
    } catch (error) {
      console.error("Failed to blaze:", error);
      showBlazeResult("failure");
      setTxStep("idle");
      resetWrite();
    }
  }, [
    address,
    connectAsync,
    auctionState,
    primaryConnector,
    resetBlazeResult,
    resetWrite,
    showBlazeResult,
    writeContract,
    txStep,
  ]);

  useEffect(() => {
    if (!receipt) return;
    if (receipt.status === "success" || receipt.status === "reverted") {
      if (receipt.status === "reverted") {
        showBlazeResult("failure");
        setTxStep("idle");
        refetchAuctionState();
        const resetTimer = setTimeout(() => {
          resetWrite();
        }, 500);
        return () => clearTimeout(resetTimer);
      }

      // If approval succeeded, now call buy
      if (txStep === "approving") {
        resetWrite();
        setTxStep("buying");
        return;
      }

      // If buy succeeded
      if (txStep === "buying") {
        showBlazeResult("success");
        setTxStep("idle");
        refetchAuctionState();
        const resetTimer = setTimeout(() => {
          resetWrite();
        }, 500);
        return () => clearTimeout(resetTimer);
      }
    }
    return;
  }, [receipt, refetchAuctionState, resetWrite, showBlazeResult, txStep]);

  // Auto-trigger buy after approval
  useEffect(() => {
    if (txStep === "buying" && !isWriting && !isConfirming && !txHash) {
      handleBlaze();
    }
  }, [txStep, isWriting, isConfirming, txHash, handleBlaze]);

  const auctionPriceDisplay = auctionState
    ? formatEth(auctionState.price, auctionState.price === 0n ? 0 : 5)
    : "—";

  const claimableDisplay = auctionState
    ? formatEth(auctionState.wethAccumulated, 8)
    : "—";

  const buttonLabel = useMemo(() => {
    if (!auctionState) return "Loading…";
    if (blazeResult === "success") return "SUCCESS";
    if (blazeResult === "failure") return "FAILURE";
    if (isWriting || isConfirming) {
      if (txStep === "approving") return "APPROVING…";
      if (txStep === "buying") return "BLAZING…";
      return "PROCESSING…";
    }
    return "BLAZE";
  }, [blazeResult, isConfirming, isWriting, auctionState, txStep]);

  const hasInsufficientLP = auctionState && auctionState.paymentTokenBalance < auctionState.price;

  // Calculate profit/loss for blazing
  const blazeProfitLoss = useMemo(() => {
    if (!auctionState) return null;

    // LP token value in USD
    const lpValueInEth = Number(formatEther(auctionState.price)) * Number(formatEther(auctionState.paymentTokenPrice));
    const lpValueInUsd = lpValueInEth * ethUsdPrice;

    // WETH value in USD
    const wethReceivedInEth = Number(formatEther(auctionState.wethAccumulated));
    const wethValueInUsd = wethReceivedInEth * ethUsdPrice;

    const profitLoss = wethValueInUsd - lpValueInUsd;
    const isProfitable = profitLoss > 0;

    return {
      profitLoss,
      isProfitable,
      lpValueInUsd,
      wethValueInUsd,
    };
  }, [auctionState, ethUsdPrice]);

  const isBlazeDisabled =
    !auctionState || isWriting || isConfirming || blazeResult !== null || hasInsufficientLP;

  const userDisplayName =
    context?.user?.displayName ?? context?.user?.username ?? "Farcaster user";
  const userHandle = context?.user?.username
    ? `@${context.user.username}`
    : context?.user?.fid
      ? `fid ${context.user.fid}`
      : "";
  const userAvatarUrl = context?.user?.pfpUrl ?? null;

  return (
    <main className="flex h-screen w-screen justify-center overflow-hidden bg-black font-mono text-white">
      <div
        className="relative flex h-full w-full max-w-[520px] flex-1 flex-col overflow-hidden rounded-[28px] bg-black px-3 pb-4 shadow-inner"
        style={{
          paddingTop: "calc(env(safe-area-inset-top, 0px) + 12px)",
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 80px)",
        }}
      >
        <div className="flex flex-1 flex-col overflow-y-auto scrollbar-hide">
          {/* Header */}
          <div className="flex items-center justify-between mb-4 sticky top-0 bg-black pb-2 z-10">
            <h1 className="text-xl font-bold tracking-wide text-cyan-400">BLAZERNOMICS</h1>
            {context?.user ? (
              <div className="flex items-center gap-2 rounded-lg bg-zinc-900/50 border border-cyan-600/20 px-2 py-1">
                <Avatar className="h-6 w-6 border border-cyan-600/30">
                  <AvatarImage
                    src={userAvatarUrl || undefined}
                    alt={userDisplayName}
                    className="object-cover"
                  />
                  <AvatarFallback className="bg-zinc-800 text-white text-xs">
                    {initialsFrom(userDisplayName)}
                  </AvatarFallback>
                </Avatar>
                <div className="leading-tight text-left">
                  <div className="text-xs font-bold">{userDisplayName}</div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Protocol Info Section */}
          <Card className="mb-3 border-cyan-600/30 bg-zinc-950/50">
            <CardContent className="p-3">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="text-xs uppercase tracking-wider text-cyan-400 font-bold mb-1">
                    Treasury Burn Protocol
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    Auction LP tokens to burn DONUT-WETH liquidity. Treasury revenue drives buybacks, increasing scarcity.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Current Auction Stats */}
          <div className="mb-3">
            <div className="text-xs uppercase tracking-wider text-gray-400 font-bold mb-2 px-1">
              Current Auction
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Card className="border-cyan-600/40 bg-gradient-to-br from-cyan-950/20 to-black">
                <CardContent className="p-2.5">
                  <div className="text-[9px] font-bold uppercase tracking-wider text-cyan-400/70 mb-1">
                    Auction Price
                  </div>
                  <div className="text-xl font-bold text-cyan-400 mb-0.5">
                    {auctionPriceDisplay}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    LP TOKENS
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    ≈ $
                    {auctionState
                      ? (
                          Number(formatEther(auctionState.price)) *
                          Number(formatEther(auctionState.paymentTokenPrice)) *
                          ethUsdPrice
                        ).toFixed(2)
                      : "0.00"}
                  </div>
                </CardContent>
              </Card>

              <Card className="border-cyan-600/30 bg-zinc-950/50">
                <CardContent className="p-2.5">
                  <div className="text-[9px] font-bold uppercase tracking-wider text-gray-400 mb-1">
                    Claimable Rewards
                  </div>
                  <div className="text-xl font-bold text-white mb-0.5">
                    Ξ{claimableDisplay}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    WETH
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    ≈ $
                    {auctionState
                      ? (
                          Number(formatEther(auctionState.wethAccumulated)) * ethUsdPrice
                        ).toFixed(2)
                      : "0.00"}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Your Position */}
          <div className="mb-3">
            <div className="text-xs uppercase tracking-wider text-gray-400 font-bold mb-2 px-1">
              Your Position
            </div>
            <Card className="border-zinc-700/50 bg-zinc-950/30">
              <CardContent className="p-2.5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-gray-400 mb-0.5">LP Balance</div>
                    <div className="text-sm font-bold text-white">
                      {address && auctionState?.paymentTokenBalance
                        ? formatEth(auctionState.paymentTokenBalance, 4)
                        : "0"}
                    </div>
                  </div>
                  <a
                    href="https://app.uniswap.org/explore/pools/base/0xD1DbB2E56533C55C3A637D13C53aeEf65c5D5703"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-cyan-400 hover:text-cyan-300 font-semibold transition-colors border border-cyan-600/30 rounded px-2 py-1"
                  >
                    Get LP →
                  </a>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Profit/Loss Analysis */}
          {blazeProfitLoss && (
            <div className="mb-3">
              <Card className={cn(
                "border",
                blazeProfitLoss.isProfitable 
                  ? "border-green-600/40 bg-green-950/20" 
                  : "border-red-600/40 bg-red-950/20"
              )}>
                <CardContent className="p-2.5">
                  <div className="flex items-start gap-2">
                    <div className="text-lg">
                      {blazeProfitLoss.isProfitable ? "💰" : "⚠️"}
                    </div>
                    <div className="flex-1">
                      <div className={cn(
                        "text-xs font-bold mb-1",
                        blazeProfitLoss.isProfitable ? "text-green-400" : "text-red-400"
                      )}>
                        {blazeProfitLoss.isProfitable ? "PROFITABLE TRADE" : "UNPROFITABLE TRADE"}
                      </div>
                      <div className="text-[11px] text-gray-400 leading-relaxed">
                        {blazeProfitLoss.isProfitable ? (
                          <>
                            Receive ${blazeProfitLoss.wethValueInUsd.toFixed(2)} WETH for ${blazeProfitLoss.lpValueInUsd.toFixed(2)} LP
                            <span className="text-green-400 font-semibold"> (+${blazeProfitLoss.profitLoss.toFixed(2)})</span>
                          </>
                        ) : (
                          <>
                            Receive ${blazeProfitLoss.wethValueInUsd.toFixed(2)} WETH for ${blazeProfitLoss.lpValueInUsd.toFixed(2)} LP
                            <span className="text-red-400 font-semibold"> (${blazeProfitLoss.profitLoss.toFixed(2)})</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Action Button */}
          <div className="mt-auto pt-3">
            <Button
              className="w-full rounded-lg bg-cyan-500 py-3 text-sm font-bold text-black transition-all hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-cyan-500/40 disabled:text-black/50"
              onClick={handleBlaze}
              disabled={isBlazeDisabled}
            >
              {buttonLabel}
            </Button>
          </div>

          {/* How It Works */}
          <div className="mt-4 pt-3 border-t border-zinc-800">
            <details className="group">
              <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-gray-400 hover:text-cyan-400 transition-colors list-none flex items-center justify-between">
                <span>How Blazernomics Works</span>
                <span className="text-cyan-400 group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="mt-3 space-y-2 text-[11px] text-gray-400 leading-relaxed">
                <p>
                  <span className="text-cyan-400 font-semibold">Dutch Auction:</span> Price starts high and decays to 0 over one hour, then resets after each purchase.
                </p>
                <p>
                  <span className="text-cyan-400 font-semibold">Burn Mechanism:</span> LP tokens are burned, removing liquidity permanently and increasing DONUT scarcity.
                </p>
                <p>
                  <span className="text-cyan-400 font-semibold">Rewards:</span> Accumulated WETH from treasury flows to participants who blaze LP tokens.
                </p>
                <p>
                  <span className="text-cyan-400 font-semibold">Strategy:</span> Time your blaze when WETH rewards exceed LP token value for profitable trades.
                </p>
              </div>
            </details>
          </div>
        </div>
      </div>
      <NavBar />
    </main>
  );
}
