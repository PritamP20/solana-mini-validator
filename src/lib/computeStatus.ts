export type LaunchStatus = "SOLD_OUT" | "UPCOMING" | "ENDED" | "ACTIVE";

export function computeStatus(
  totalSupply: number,
  totalPurchased: number,
  startsAt: Date,
  endsAt: Date
): LaunchStatus {
  const now = new Date();
  if (totalPurchased >= totalSupply) return "SOLD_OUT";
  if (now < startsAt) return "UPCOMING";
  if (now > endsAt) return "ENDED";
  return "ACTIVE";
}
