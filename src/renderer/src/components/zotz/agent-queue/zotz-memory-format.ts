const GIB = 1024 ** 3

/** "3.1" — gigabytes with one decimal, the unit the queue copy uses. */
export function formatZotzGb(bytes: number): string {
  return (Math.max(0, bytes) / GIB).toFixed(1)
}
