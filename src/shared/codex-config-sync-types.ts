// Last-good runtime settings remain active during source stalls. Keep managed-home-unavailable separate from system-source failures (e.g. Windows antivirus locks) so recovery points to the correct path.
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
