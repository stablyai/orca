import { markEnvironmentUsed } from './runtime-environment-store'

/** Last-used bookkeeping must never fail a reply that already arrived: read-only stores and removed environments skip it. */
export function recordRuntimeEnvironmentUsage(
  userDataPath: string,
  selector: string,
  args: Parameters<typeof markEnvironmentUsed>[2] = {}
): void {
  void markEnvironmentUsed(userDataPath, selector, args).catch((error: unknown) => {
    console.warn(
      `Skipped last-used bookkeeping for runtime environment ${selector}:`,
      error instanceof Error ? error.message : error
    )
  })
}
