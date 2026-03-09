import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { computeStatus } from "../lib/computeStatus";

const router = Router({ mergeParams: true });

function calcTieredCost(amount: number, tiers: any[], flatPrice: number): number {
  const sorted = [...tiers].sort((a, b) => a.minAmount - b.minAmount);
  let remaining = amount;
  let cost = 0;
  for (const tier of sorted) {
    if (remaining <= 0) break;
    const capacity = tier.maxAmount - tier.minAmount;
    const take = Math.min(remaining, capacity);
    cost += take * tier.pricePerToken;
    remaining -= take;
  }
  if (remaining > 0) cost += remaining * flatPrice;
  return cost;
}

router.post("/purchase", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id: launchId } = req.params;
  const { walletAddress, amount, txSignature, referralCode } = req.body;

  if (!walletAddress || amount == null || !txSignature) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const launch = await prisma.launch.findUnique({
    where: { id: launchId },
    include: { tiers: true, whitelist: true },
  });
  if (!launch) {
    res.status(404).json({ error: "Launch not found" });
    return;
  }

  const totalPurchasedAgg = await prisma.purchase.aggregate({ where: { launchId }, _sum: { amount: true } });
  const totalPurchased = totalPurchasedAgg._sum.amount ?? 0;
  const status = computeStatus(launch.totalSupply, totalPurchased, launch.startsAt, launch.endsAt);
  if (status !== "ACTIVE") {
    res.status(400).json({ error: `Launch is ${status}` });
    return;
  }

  if (launch.whitelist.length > 0) {
    const inList = launch.whitelist.some((w: any) => w.address === walletAddress);
    if (!inList) {
      res.status(400).json({ error: "Wallet not whitelisted" });
      return;
    }
  }

  const userPurchasedAgg = await prisma.purchase.aggregate({
    where: { launchId, userId: req.userId! },
    _sum: { amount: true },
  });
  const userPurchased = userPurchasedAgg._sum.amount ?? 0;
  if (userPurchased + Number(amount) > launch.maxPerWallet) {
    res.status(400).json({ error: "Exceeds maxPerWallet limit" });
    return;
  }

  if (totalPurchased + Number(amount) > launch.totalSupply) {
    res.status(400).json({ error: "Exceeds total supply" });
    return;
  }

  const dup = await prisma.purchase.findUnique({ where: { txSignature } });
  if (dup) {
    res.status(400).json({ error: "Duplicate transaction signature" });
    return;
  }

  let totalCost =
    launch.tiers.length > 0
      ? calcTieredCost(Number(amount), launch.tiers, launch.pricePerToken)
      : Number(amount) * launch.pricePerToken;

  let referralCodeId: string | null = null;
  if (referralCode) {
    const ref = await prisma.referralCode.findUnique({
      where: { launchId_code: { launchId, code: referralCode } },
    });
    if (!ref || ref.usedCount >= ref.maxUses) {
      res.status(400).json({ error: "Invalid or exhausted referral code" });
      return;
    }
    totalCost = totalCost * (1 - ref.discountPercent / 100);
    referralCodeId = ref.id;
    await prisma.referralCode.update({ where: { id: ref.id }, data: { usedCount: { increment: 1 } } });
  }

  const purchase = await prisma.purchase.create({
    data: {
      launchId,
      userId: req.userId!,
      walletAddress,
      amount: Number(amount),
      totalCost,
      txSignature,
      referralCodeId,
    },
  });

  res.status(201).json(purchase);
});

router.get("/purchases", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id: launchId } = req.params;
  const launch = await prisma.launch.findUnique({ where: { id: launchId } });
  if (!launch) {
    res.status(404).json({ error: "Launch not found" });
    return;
  }

  const isCreator = launch.creatorId === req.userId;
  const purchases = await prisma.purchase.findMany({
    where: isCreator ? { launchId } : { launchId, userId: req.userId! },
  });

  res.json({ purchases, total: purchases.length });
});

export default router;
