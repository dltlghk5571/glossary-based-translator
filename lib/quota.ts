import { prisma } from "./prisma";
import { isSamePeriod, computeRemaining } from "./quota-math";

export type QuotaSnapshot = { limit: number; used: number; bonus: number; remaining: number };

// Applies the lazy monthly reset (if the stored period has rolled over) then
// returns the current snapshot. Mirrors db_users.get_quota() on the Python
// side -- both runtimes read/write the same User row, so keep the reset
// logic in sync between the two if it ever changes.
export async function getQuotaSnapshot(userId: number, now: Date = new Date()): Promise<QuotaSnapshot> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { monthlyTokenLimit: true, tokensUsedThisPeriod: true, bonusTokens: true, periodStart: true },
  });

  let used = user.tokensUsedThisPeriod;
  let bonus = user.bonusTokens;

  if (!isSamePeriod(user.periodStart, now)) {
    used = 0;
    bonus = 0;
    await prisma.user.update({
      where: { id: userId },
      data: { tokensUsedThisPeriod: 0, bonusTokens: 0, periodStart: now },
    });
  }

  return { limit: user.monthlyTokenLimit, used, bonus, remaining: computeRemaining(user.monthlyTokenLimit, bonus, used) };
}
