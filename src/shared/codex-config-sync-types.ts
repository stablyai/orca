// Why: the managed runtime config keeps serving the last good settings while the
// source is unusable, so a stall is "working but not picking up your edits" —
// the reason is what makes it actionable, and the path is what the user fixes.
// Why: the first three describe the SYSTEM config source. 'managed-home-unavailable'
// describes the managed home itself being temporarily unreadable (e.g. an antivirus
// lock on Windows) — a different file and a different remedy, so it needs its own
// reason rather than borrowing 'unreadable-source' and blaming the wrong path.
export type CodexConfigSyncStallReason =
  | 'missing-source'
  | 'blank-source'
  | 'unreadable-source'
  | 'managed-home-unavailable'

export type CodexConfigSyncStatus =
  | { state: 'synced'; reason: null; systemConfigPath: string }
  | {
      state: 'stalled'
      reason: CodexConfigSyncStallReason
      systemConfigPath: string
      /** Optional for compatibility with status producers that cannot resolve the managed path. */
      managedStatePath?: string
    }
