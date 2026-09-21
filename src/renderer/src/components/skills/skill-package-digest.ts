/**
 * Digests are shown so a reader can eyeball that two packages match; the full
 * 64 characters never fit a dialog, and rendering them on one nowrap line sets
 * the dialog's minimum content width and makes it scroll sideways.
 */
export function shortDigest(digest: string): string {
  return digest.length > 16 ? `${digest.slice(0, 8)}…${digest.slice(-6)}` : digest
}
