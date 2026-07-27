// Why: the managed runtime config keeps serving the last good settings while the
// source is unusable, so a stall is "working but not picking up your edits" —
// the reason is what makes it actionable, and the path is what the user fixes.
export type CodexConfigSyncStallReason = 'missing-source' | 'blank-source' | 'unreadable-source'

export type CodexConfigSyncStatus =
  | { state: 'synced'; reason: null; systemConfigPath: string }
  | { state: 'stalled'; reason: CodexConfigSyncStallReason; systemConfigPath: string }
