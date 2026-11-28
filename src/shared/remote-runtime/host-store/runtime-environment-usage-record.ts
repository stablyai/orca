import { markEnvironmentUsed } from './runtime-environment-store'
import { noteSharedHostRuntime } from '../pairing/shared-host-keys'

/** Last-used bookkeeping must never fail a reply that already arrived: read-only stores and removed environments skip it. */
export function recordRuntimeEnvironmentUsage(
  userDataPath: string,
  selector: string,
  args: Parameters<typeof markEnvironmentUsed>[2] = {}
): void {
  // A shared agent's host is never in the store: only its runtime is kept, in memory.
  if (noteSharedHostRuntime(selector, args.runtimeId)) {
    return
  }
  void markEnvironmentUsed(userDataPath, selector, args).catch((error: unknown) => {
    console.warn(
      `Skipped last-used bookkeeping for runtime environment ${selector}:`,
      error instanceof Error ? error.message : error
    )
  })
}
