/** Why the last upload to tokn did not land; the renderer owns the copy for each. */
export type ToknSyncErrorCode =
  | 'tracking-off'
  | 'network'
  | 'rate-limited'
  | 'rejected'
  | 'server'
  | 'signed-out'

export type ToknSyncStatus = {
  connected: boolean
  /** True while the browser sign-in is open. */
  connecting: boolean
  syncing: boolean
  handle: string | null
  profileUrl: string | null
  lastSyncAt: number | null
  lastSyncError: ToknSyncErrorCode | null
  /** The server's own explanation for `lastSyncError`, when it gave one. */
  lastSyncErrorDetail: string | null
  lastSyncAccepted: number | null
  lastSyncRejected: number | null
  /** Usage tracking Orca must have on for that tool's totals to be published. */
  tracking: { claude: boolean; codex: boolean }
}

export type ToknConnectResult = {
  outcome: 'connected' | 'cancelled' | 'timed-out' | 'failed'
  error?: string
  status: ToknSyncStatus
}

/** One uploaded row: a (day, tool, model) total, never anything naming a project. */
export type ToknSyncRow = {
  day: string
  tool: 'claude-code' | 'codex'
  model: string
  requests: number
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  costUsd: number
  fast: boolean
}

/** Exactly what the next upload would send. */
export type ToknUploadPreview = {
  endpoint: string
  body: {
    rows: ToknSyncRow[]
    timezone: string
    scannedAt: string
    cliVersion: string
  }
}
