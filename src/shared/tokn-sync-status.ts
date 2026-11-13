import { z } from 'zod'

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
  tracking: ToknTracking
}

export type ToknConnectResult = {
  outcome: 'connected' | 'cancelled' | 'timed-out' | 'failed'
  error?: string
  status: ToknSyncStatus
}

const count = z.number().nonnegative()

/** One uploaded row: a (day, tool, model) total. Strict, so a field naming a project cannot pass. */
export const ToknSyncRowSchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    tool: z.enum(['claude-code', 'codex']),
    model: z.string().min(1).max(120),
    requests: count,
    input: count,
    output: count,
    cacheWrite5m: count,
    cacheWrite1h: count,
    cacheRead: count,
    costUsd: count,
    fast: z.boolean()
  })
  .strict()
export type ToknSyncRow = z.infer<typeof ToknSyncRowSchema>

export const ToknTrackingSchema = z.object({ claude: z.boolean(), codex: z.boolean() }).strict()
export type ToknTracking = z.infer<typeof ToknTrackingSchema>

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
