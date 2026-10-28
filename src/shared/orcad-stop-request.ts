/** Stop files reach only the watching orcad; signals from stale PID records could stop an unrelated reused process. */
import { z } from 'zod'
import { openEnum } from './zod-salvage'

/** Plain request in the slot directory: the same graceful stop as SIGTERM. */
export const ORCAD_STOP_REQUEST_FILENAME = '.orcad-stop-request'
/** Prefix of an instance-bound request in the data root; older listeners never match it. */
export const ORCAD_MANAGED_STOP_REQUEST_PREFIX = '.orcad-managed-stop-request'
export const ORCAD_MANAGED_STOP_REQUEST_MAX_BYTES = 32 * 1024
export const ORCAD_STOP_RECEIPTS_DIRNAME = 'orcad-stop-receipts'
export const ORCAD_COMPLETE_MANAGED_STOP_FLAG = '--complete-managed-stop'
/** Names a staged request file instead of inline JSON; Windows hosts never put the JSON on argv. */
export const ORCAD_MANAGED_STOP_REQUEST_FILE_FLAG = '--request-file'

/** One orcad process: its PID, start time, and the instance lock record it published. */
export const OrcadManagedStopInstanceSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  startedAtMs: z.number().finite().nonnegative().nullable(),
  /** Linux only, copied from the lock; older clients omit it and older slots drop it. */
  linuxStartTicks: z.string().regex(/^\d+$/).max(32).optional().catch(undefined),
  bootId: z.string().min(1).max(255).optional().catch(undefined),
  nonce: z.string().min(1).max(255),
  lockPath: z.string().min(1).max(4096)
})

// Older slots drop newer optional request fields rather than refuse the stop.
export const OrcadManagedStopRequestSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.uuid(),
  version: z.string().min(1).max(255),
  runtimeId: z.string().min(1).max(255),
  instance: OrcadManagedStopInstanceSchema,
  /** Best effort: also retire the terminal daemon if it is provably idle. Never blocks the stop. */
  retireIdleDaemon: z.literal(true).optional()
})

export type OrcadManagedStopInstance = z.infer<typeof OrcadManagedStopInstanceSchema>
export type OrcadManagedStopRequest = z.infer<typeof OrcadManagedStopRequestSchema>

/** Equality key for a request; omits the incarnation, which an older client recovering it drops. */
export function orcadManagedStopRequestKey(request: OrcadManagedStopRequest): string {
  const { instance, ...rest } = OrcadManagedStopRequestSchema.parse(request)
  const { linuxStartTicks: _ticks, bootId: _bootId, ...bound } = instance
  return JSON.stringify({ ...rest, instance: bound })
}
/** What a stopping orcad must match before a managed request may stop it. */
export type OrcadManagedStopContext = Omit<
  OrcadManagedStopRequest,
  'schemaVersion' | 'transactionId'
>

const STOP_VERDICTS = ['live', 'unverifiable', 'exited'] as const
const RETIREMENT_VERDICTS = ['retired', 'live', 'unverifiable'] as const

/** The execution host's verdict; `exited` only on proof, never on silence. */
export const OrcadManagedStopVerdictSchema = z.enum(STOP_VERDICTS)

/** `retired` only when the daemon accepted; a busy daemon stays up and keeps its terminals. */
export const OrcadDaemonRetirementVerdictSchema = z.enum(RETIREMENT_VERDICTS)

// Read by clients older than the slot that printed them: unknown fields and arms degrade.
const stopReplyRequestFields = OrcadManagedStopRequestSchema.shape

export const OrcadManagedStopCompletionSchema = z.object({
  ...stopReplyRequestFields,
  kind: z.literal('orcad_managed_stop_completion'),
  verdict: openEnum(STOP_VERDICTS, 'unverifiable'),
  receiptPersisted: z.boolean(),
  /** For a request that asked to retire the daemon, the outcome its receipt recorded. */
  retirement: openEnum(RETIREMENT_VERDICTS, 'unverifiable').optional()
})

/** What the stopping orcad observed about its daemon, written before it exits. */
export const OrcadDaemonRetirementRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('orcad_managed_stop_retirement'),
  request: OrcadManagedStopRequestSchema,
  retirement: OrcadDaemonRetirementVerdictSchema,
  liveSessions: z.number().int().nonnegative().nullable(),
  reason: z.string().max(4096).nullable()
})

export const OrcadCompletedStopReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('orcad_managed_stop_completed'),
  request: OrcadManagedStopRequestSchema,
  exitedAt: z.iso.datetime({ offset: true }),
  /** Present only when the request asked to retire the daemon. */
  retirement: OrcadDaemonRetirementVerdictSchema.optional()
})

export type OrcadManagedStopVerdict = z.infer<typeof OrcadManagedStopVerdictSchema>
export type OrcadManagedStopCompletion = z.infer<typeof OrcadManagedStopCompletionSchema>
export type OrcadCompletedStopReceipt = z.infer<typeof OrcadCompletedStopReceiptSchema>
export type OrcadDaemonRetirementVerdict = z.infer<typeof OrcadDaemonRetirementVerdictSchema>
export type OrcadDaemonRetirementRecord = z.infer<typeof OrcadDaemonRetirementRecordSchema>

export const ORCAD_CANCEL_MANAGED_STOP_FLAG = '--cancel-managed-stop'
/** Readiness `health.stopRequests`: this build consumes stop files and both commands above. */
export const ORCAD_STOP_REQUESTS_CAPABILITY = 1

/** Exclusive per-transaction creation ensures only orcad dispatch or client cancellation can win. */
export const OrcadManagedStopDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('orcad_managed_stop_decision'),
  request: OrcadManagedStopRequestSchema,
  decision: z.enum(['dispatched', 'canceled'])
})

/** `dispatched` means orcad already acted on the request; the caller must await its exit. */
export const OrcadManagedStopCancellationSchema = z.object({
  ...stopReplyRequestFields,
  kind: z.literal('orcad_managed_stop_cancellation'),
  // Unknown degrades to `dispatched`: the caller then awaits exit rather than assume a cancel.
  outcome: openEnum(['canceled', 'dispatched'], 'dispatched')
})

export type OrcadManagedStopDecision = z.infer<typeof OrcadManagedStopDecisionSchema>
export type OrcadManagedStopCancellation = z.infer<typeof OrcadManagedStopCancellationSchema>
