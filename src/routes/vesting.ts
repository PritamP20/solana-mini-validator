import { Router, Response, Request } from "express";
import prisma from "../lib/prisma";

const router = Router({ mergeParams: true });

router.get("/", async (req: Request, res: Response): Promise<void> => {
  const { id: launchId } = req.params;
  const { walletAddress } = req.query;

  if (!walletAddress) {
    res.status(400).json({ error: "Missing walletAddress" });
    return;
  }

  const launch = await prisma.launch.findUnique({
    where: { id: launchId },
    include: { vesting: true },
  });
  if (!launch) {
    res.status(404).json({ error: "Launch not found" });
    return;
  }

  const agg = await prisma.purchase.aggregate({
    where: { launchId, walletAddress: walletAddress as string },
    _sum: { amount: true },
  });
  const totalPurchased = agg._sum.amount ?? 0;

  if (!launch.vesting) {
    res.json({
      totalPurchased,
      tgeAmount: totalPurchased,
      cliffEndsAt: null,
      vestedAmount: totalPurchased,
      lockedAmount: 0,
      claimableAmount: totalPurchased,
    });
    return;
  }

  const { cliffDays, vestingDays, tgePercent } = launch.vesting;
  const tgeAmount = Math.floor(totalPurchased * tgePercent / 100);
  const remaining = totalPurchased - tgeAmount;
  const cliffEndsAt = new Date(launch.startsAt.getTime() + cliffDays * 86400000);
  const now = new Date();

  let vestedAmount = 0;
  if (now >= cliffEndsAt) {
    const vestingEndsAt = new Date(cliffEndsAt.getTime() + vestingDays * 86400000);
    const elapsed = Math.min(now.getTime(), vestingEndsAt.getTime()) - cliffEndsAt.getTime();
    const vestingMs = vestingDays * 86400000;
    vestedAmount = vestingDays > 0 ? (elapsed / vestingMs) * remaining : remaining;
  }

  const lockedAmount = remaining - vestedAmount;
  const claimableAmount = tgeAmount + vestedAmount;

  res.json({
    totalPurchased,
    tgeAmount,
    cliffEndsAt,
    vestedAmount,
    lockedAmount,
    claimableAmount,
  });
});

export default router;
