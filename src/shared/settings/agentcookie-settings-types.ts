/** Optional agentcookie CLI sync for the embedded browser. Inert unless the user opts in. */
export type AgentcookieSettings = {
  /** Pull the session from `agentcookie export` instead of a manual import. Off by default. */
  agentcookieSyncEnabled?: boolean
  /** Absolute path of the executable the user approved. Never resolved from PATH. */
  agentcookieBinaryPath?: string | null
  /** Runtime status set by the sync loop: whether the approved path is executable. */
  agentcookieDetected?: boolean
  /** Unix timestamp (ms) of the last finished sync. */
  agentcookieLastSyncAt?: number | null
  /** Number of cookies the last successful sync imported. */
  agentcookieLastImportedCount?: number | null
}
