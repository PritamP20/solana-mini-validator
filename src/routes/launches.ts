import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";
import { computeStatus, LaunchStatus } from "../lib/computeStatus";

const router = Router();

async function getTotalPurchased(launchId: string): Promise<number> {
  const result = await prisma.purchase.aggregate({
    where: { launchId },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

function attachStatus(launch: any, totalPurchased: number) {
  return {
    ...launch,
    status: computeStatus(
      launch.totalSupply,
      totalPurchased,
      launch.startsAt,
      launch.endsAt
    ),
  };
}

function calcTieredCost(amount: number, tiers: any[], flatPrice: number): number {
  const sorted = [...tiers].sort((a: any, b: any) => a.minAmount - b.minAmount);
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

router.post("/", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const {
    name, symbol, totalSupply, pricePerToken,
    startsAt, endsAt, maxPerWallet, description,
    tiers, vesting,
  } = req.body;

  if (!name || !symbol || totalSupply == null || pricePerToken == null ||
    !startsAt || !endsAt || maxPerWallet == null || !description) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const launch = await prisma.launch.create({
    data: {
      creatorId: req.userId!,
      name,
      symbol,
      totalSupply: Number(totalSupply),
      pricePerToken: Number(pricePerToken),
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      maxPerWallet: Number(maxPerWallet),
      description,
      tiers: tiers
        ? {
          create: tiers.map((t: any) => ({
            minAmount: Number(t.minAmount),
            maxAmount: Number(t.maxAmount),
            pricePerToken: Number(t.pricePerToken),
          })),
        }
        : undefined,
      vesting: vesting
        ? {
          create: {
            cliffDays: Number(vesting.cliffDays),
            vestingDays: Number(vesting.vestingDays),
            tgePercent: Number(vesting.tgePercent),
          },
        }
        : undefined,
    },
    include: { tiers: true, vesting: true },
  });

  res.status(201).json(attachStatus(launch, 0));
});

router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.max(1, parseInt(req.query.limit as string) || 10);
  const statusFilter = req.query.status as LaunchStatus | undefined;

  const allLaunches = await prisma.launch.findMany({
    include: { tiers: true, vesting: true },
    orderBy: { createdAt: "desc" },
  });

  const withStatus = await Promise.all(
    allLaunches.map(async (l: any) => {
      const tp = await getTotalPurchased(l.id);
      return attachStatus(l, tp);
    })
  );

  const filtered = statusFilter
    ? withStatus.filter((l: any) => l.status === statusFilter)
    : withStatus;

  const total = filtered.length;
  const launches = filtered.slice((page - 1) * limit, page * limit);

  res.json({ launches, total, page, limit });
});

router.get("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const launch = await prisma.launch.findUnique({
    where: { id: req.params.id },
    include: { tiers: true, vesting: true },
  });
  if (!launch) {
    res.status(404).json({ error: "Launch not found" });
    return;
  }
  const tp = await getTotalPurchased(launch.id);
  res.json(attachStatus(launch, tp));
});

router.put("/:id", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const launch = await prisma.launch.findUnique({ where: { id: req.params.id } });
  if (!launch) {
    res.status(404).json({ error: "Launch not found" });
    return;
  }
  if (launch.creatorId !== req.userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const {
    name, symbol, totalSupply, pricePerToken,
    startsAt, endsAt, maxPerWallet, description,
  } = req.body;

  const updated = await prisma.launch.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined && { name }),
      ...(symbol !== undefined && { symbol }),
      ...(totalSupply !== undefined && { totalSupply: Number(totalSupply) }),
      ...(pricePerToken !== undefined && { pricePerToken: Number(pricePerToken) }),
      ...(startsAt !== undefined && { startsAt: new Date(startsAt) }),
      ...(endsAt !== undefined && { endsAt: new Date(endsAt) }),
      ...(maxPerWallet !== undefined && { maxPerWallet: Number(maxPerWallet) }),
      ...(description !== undefined && { description }),
    },
    include: { tiers: true, vesting: true },
  });

  const tp = await getTotalPurchased(updated.id);
  res.json(attachStatus(updated, tp));
});

router.post("/:id/purchase", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
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
    data: { launchId, userId: req.userId!, walletAddress, amount: Number(amount), totalCost, txSignature, referralCodeId },
  });

  res.status(201).json(purchase);
});

router.get("/:id/purchases", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
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
