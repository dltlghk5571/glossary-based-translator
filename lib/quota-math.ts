export function isSamePeriod(periodStart: Date, now: Date): boolean {
  return periodStart.getUTCFullYear() === now.getUTCFullYear() && periodStart.getUTCMonth() === now.getUTCMonth();
}

export function computeRemaining(limit: number, bonus: number, used: number): number {
  return limit + bonus - used;
}
