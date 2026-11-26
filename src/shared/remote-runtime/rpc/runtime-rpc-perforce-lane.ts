// Why: p4 scans, syncs and copy removals run for minutes on large workspaces, so Perforce gets its
// own queue rather than holding the slots Git status and listing refreshes share.
const PERFORCE_BACKGROUND_METHODS: ReadonlySet<string> = new Set([
  'perforce.detect',
  'perforce.status',
  'perforce.history',
  'perforce.detectProject',
  'perforce.syncCopies'
])

/** Perforce refreshes that may wait behind foreground work, like Git status. */
export function isPerforceBackgroundRuntimeMethod(method: string): boolean {
  return PERFORCE_BACKGROUND_METHODS.has(method)
}

/** Every Perforce call runs in its own per-selector queue. */
export function isPerforceRuntimeMethod(method: string): boolean {
  return method.startsWith('perforce.')
}
