import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/auth";

const router = Router({ mergeParams: true });

async function requireCreator(launchId: string, userId: string, res: Response): Promise<boolean> {
  const launch = await prisma.launch.findUnique({ where: { id: launchId } });
  if (!launch) {
    res.status(404).json({ error: "Launch not found" });
    return false;
  }
  if (launch.creatorId !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

router.post("/", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id: launchId } = req.params;
  if (!(await requireCreator(launchId, req.userId!, res))) return;

  const { addresses } = req.body;
  if (!Array.isArray(addresses) || addresses.length === 0) {
    res.status(400).json({ error: "addresses must be a non-empty array" });
    return;
  }

  let added = 0;
  for (const address of addresses) {
    try {
      await prisma.whitelistEntry.create({ data: { launchId, address } });
      added++;
    } catch {
      // duplicate — skip
    }
  }

  const total = await prisma.whitelistEntry.count({ where: { launchId } });
  res.json({ added, total });
});

router.get("/", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id: launchId } = req.params;
  if (!(await requireCreator(launchId, req.userId!, res))) return;

  const entries = await prisma.whitelistEntry.findMany({ where: { launchId } });
  res.json({ addresses: entries.map((e: any) => e.address), total: entries.length });
});

router.delete("/:address", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id: launchId, address } = req.params;
  if (!(await requireCreator(launchId, req.userId!, res))) return;

  const entry = await prisma.whitelistEntry.findFirst({ where: { launchId, address } });
  if (!entry) {
    res.status(404).json({ error: "Address not found in whitelist" });
    return;
  }
  await prisma.whitelistEntry.delete({ where: { id: entry.id } });
  res.json({ removed: true });
});

export default router;
