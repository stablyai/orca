import { markEnvironmentUsed } from './runtime-environment-store'
import { sharedHostEnvironment } from '../pairing/shared-host-keys'

/** Last-used bookkeeping must never fail a reply that already arrived: read-only stores and removed environments skip it. */
export function recordRuntimeEnvironmentUsage(
  userDataPath: string,
  selector: string,
  args: Parameters<typeof markEnvironmentUsed>[2] = {}
): void {
  // A shared agent's host is never in the store: nothing to record.
  if (sharedHostEnvironment(selector)) {
    return
  }
  void markEnvironmentUsed(userDataPath, selector, args).catch((error: unknown) => {
    console.warn(
      `Skipped last-used bookkeeping for runtime environment ${selector}:`,
      error instanceof Error ? error.message : error
    )
  })
}
