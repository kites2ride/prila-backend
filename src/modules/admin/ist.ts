/** Convert YYYY-MM-DD (IST calendar day) to UTC Date bounds. */
export function istDayBounds(fromYmd: string, toYmd: string): { from: Date; to: Date } {
  const from = new Date(`${fromYmd}T00:00:00.000+05:30`);
  const to = new Date(`${toYmd}T23:59:59.999+05:30`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new Error('Invalid date range');
  }
  return { from, to };
}
