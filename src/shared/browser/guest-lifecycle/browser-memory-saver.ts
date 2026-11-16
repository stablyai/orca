export const DEFAULT_BROWSER_MEMORY_SAVER_HOURS = 4
export const MIN_BROWSER_MEMORY_SAVER_HOURS = 1
export const MAX_BROWSER_MEMORY_SAVER_HOURS = 168

export type BrowserMemorySaverGlobalSettings = {
  /** Settings > Browser > Memory Saver; kept under its earlier kill-switch key so opt-outs carry over. */
  browserGuestWorktreeRetentionBudget?: boolean
  /** Awake hours a hidden page goes unviewed before it is freed. */
  browserMemorySaverHours?: number
}

export type BrowserMemorySaverPolicy = { enabled: boolean; idleMs: number }

/** Whole hours in range; missing or malformed persisted values fall back to the default. */
export function getEffectiveBrowserMemorySaverHours(hours: unknown): number {
  if (typeof hours !== 'number' || !Number.isFinite(hours)) {
    return DEFAULT_BROWSER_MEMORY_SAVER_HOURS
  }
  return Math.min(
    MAX_BROWSER_MEMORY_SAVER_HOURS,
    Math.max(MIN_BROWSER_MEMORY_SAVER_HOURS, Math.round(hours))
  )
}

export function readBrowserMemorySaverPolicy(
  settings: BrowserMemorySaverGlobalSettings | null | undefined
): BrowserMemorySaverPolicy {
  return {
    enabled: settings?.browserGuestWorktreeRetentionBudget !== false,
    idleMs: getEffectiveBrowserMemorySaverHours(settings?.browserMemorySaverHours) * 60 * 60_000
  }
}
