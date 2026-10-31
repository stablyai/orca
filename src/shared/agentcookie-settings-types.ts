/** Optional agentcookie CLI sync for the embedded browser. Inert when the CLI is not installed. */
export type AgentcookieSettings = {
  /** Pull the session from `agentcookie export` instead of a manual import. On by default. */
  agentcookieSyncEnabled?: boolean
  /** Runtime status set by the sync loop. */
  agentcookieDetected?: boolean
  /** Unix timestamp (ms) of the last finished sync. */
  agentcookieLastSyncAt?: number | null
  /** Number of cookies the last successful sync imported. */
  agentcookieLastImportedCount?: number | null
}
