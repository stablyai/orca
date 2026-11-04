/** How long `orca wait` waits for a condition when no --timeout is given. */
export const BROWSER_WAIT_DEFAULT_TIMEOUT_MS = 25_000

/** Deadline for a hop that forwards `browser.wait`; it outlives the wait so the host reports the timeout. */
export function browserWaitRequestTimeoutMs(timeout: unknown): number {
  return Math.max(60_000, (typeof timeout === 'number' ? timeout : 0) + 30_000)
}
