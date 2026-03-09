import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";

const router = Router({ mergeParams: true });

router.post("/", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id: launchId } = req.params;
  const launch = await prisma.launch.findUnique({ where: { id: launchId } });
  if (!launch) {
    res.status(404).json({ error: "Launch not found" });
    return;
  }
  if (launch.creatorId !== req.userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { code, discountPercent, maxUses } = req.body;
  if (!code || discountPercent == null || maxUses == null) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const existing = await prisma.referralCode.findUnique({
    where: { launchId_code: { launchId, code } },
  });
  if (existing) {
    res.status(409).json({ error: "Referral code already exists for this launch" });
    return;
  }

  const referral = await prisma.referralCode.create({
    data: {
      launchId,
      code,
      discountPercent: Number(discountPercent),
      maxUses: Number(maxUses),
    },
  });

  res.status(201).json({
    id: referral.id,
    code: referral.code,
    discountPercent: referral.discountPercent,
    maxUses: referral.maxUses,
    usedCount: referral.usedCount,
  });
});

router.get("/", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id: launchId } = req.params;
  const launch = await prisma.launch.findUnique({ where: { id: launchId } });
  if (!launch) {
    res.status(404).json({ error: "Launch not found" });
    return;
  }
  if (launch.creatorId !== req.userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const referrals = await prisma.referralCode.findMany({ where: { launchId } });
  res.json(referrals);
});

export default router;
