/** Keep both digest ends for comparison without forcing dialog-wide unbroken text. */
export function shortDigest(digest: string): string {
  return digest.length > 16 ? `${digest.slice(0, 8)}…${digest.slice(-6)}` : digest
}
