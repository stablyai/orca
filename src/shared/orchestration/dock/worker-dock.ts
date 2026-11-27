import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import * as z from 'zod'
import { CrewParty } from '../orchestration-crew'

export const WorkerDockSource = lazyZodSchema(() => z.object({ party: CrewParty }))
export const WorkerDockSubscribe = lazyZodSchema(() =>
  WorkerDockSource.extend({
    includeRows: z.boolean().optional(),
    /** Only current work: live workers and recent, unresolved failures (see workerDockCurrentRowsSql). */
    currentOnly: z.boolean().optional()
  })
)
/** How long a ready worker whose agent status is not fresh stays in the strip after its last
 *  change: longer than nearly every worker runs, so only a stale record ages out. */
export const WORKER_DOCK_UNVERIFIED_READY_MS = 24 * 60 * 60_000
/** A launch or stop whose outcome was never seen is fenced off after an hour. */
export const WORKER_DOCK_UNKNOWN_MS = 60 * 60_000
/** A failure stays a current attention item for four hours; after that it lives in history. */
export const WORKER_DOCK_FAILURE_MS = 4 * 60 * 60_000
/** At most this many failures show at once, newest first. */
export const WORKER_DOCK_FAILURE_LIMIT = 4
export const WorkerDockState = lazyZodSchema(() =>
  z.enum([
    'starting',
    'running',
    'waiting',
    'saving',
    'failed',
    'unexpected',
    'stopping',
    'unavailable',
    'needs-you',
    'idle',
    'coordinator'
  ])
)
export const WorkerDockEntry = lazyZodSchema(() =>
  z.object({
    kind: z
      .enum(['worker', 'agent', 'command', 'workflow', 'monitor', 'unknown'])
      .default('worker'),
    id: z.string(),
    dispatchId: z.string(),
    source: z.string(),
    name: z.string(),
    title: z.string(),
    model: z.string().nullable(),
    state: WorkerDockState,
    changedAt: z.number().nullable(),
    startedAt: z.number().nullable(),
    reason: z.string().nullable(),
    progressNote: z.string().optional(),
    settlement: z.string().nullable(),
    resultId: z.string().nullable(),
    stoppable: z.boolean(),
    ownerActionsAvailable: z.boolean().default(true)
  })
)
export type WorkerDockEntry = z.infer<typeof WorkerDockEntry>
export const WorkerDockIdentity = lazyZodSchema(() =>
  WorkerDockEntry.pick({
    id: true,
    dispatchId: true,
    state: true,
    changedAt: true,
    ownerActionsAvailable: true,
    settlement: true
  }).extend({ kind: WorkerDockEntry.shape.kind.optional(), hasModel: z.boolean().default(false) })
)
export const WorkerDockSnapshot = lazyZodSchema(() =>
  z.object({
    revision: z.number(),
    currentOnly: z.literal(true).optional(),
    nextExpiry: z.number().optional(),
    hasUnverifiedWorkers: z.boolean().optional(),
    unavailable: z.boolean().optional(),
    expired: z.boolean(),
    identities: z.array(WorkerDockIdentity),
    rows: z.array(WorkerDockEntry),
    anchor: z.string().nullable()
  })
)
export type WorkerDockSnapshot = z.infer<typeof WorkerDockSnapshot>
export const WorkerDockRead = lazyZodSchema(() =>
  WorkerDockSubscribe.extend({
    seed: z.boolean().optional(),
    revision: z.number().optional(),
    anchor: z.string().optional(),
    direction: z.enum(['before', 'after', 'around']).default('around')
  })
)
export const WorkerDockAcknowledge = lazyZodSchema(() =>
  WorkerDockSource.extend({
    settlements: z.array(z.object({ dispatchId: z.string(), settlement: z.string() })).max(1000),
    acknowledged: z.boolean()
  })
)
export const WorkerDockResult = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    dispatchId: z.string(),
    name: z.string(),
    title: z.string(),
    outcome: z.enum(['succeeded', 'failed', 'stopped', 'unexpected']),
    body: z.string(),
    /** True when the body is the worker's own report (Markdown); false for a raw error or a stop
     *  note. Optional: older hosts omit it, and their bodies keep rendering as Markdown. */
    report: z.boolean().optional(),
    at: z.number().nullable(),
    settlement: z.string(),
    acknowledged: z.boolean(),
    ownerActionsAvailable: z.boolean().default(true),
    /** The worker's workspace on its host, so the card can say when it was removed. Older hosts omit it. */
    workspaceId: z.string().optional()
  })
)
export type WorkerDockResult = z.infer<typeof WorkerDockResult>
/** A failed row this owner can acknowledge; Clear all sends exactly these. */
export function workerDockClearable(row: {
  state: WorkerDockEntry['state']
  settlement?: string | null
  ownerActionsAvailable?: boolean
}): row is { state: 'failed' | 'unexpected'; settlement: string; ownerActionsAvailable?: boolean } {
  return (
    (row.state === 'failed' || row.state === 'unexpected') &&
    Boolean(row.settlement) &&
    row.ownerActionsAvailable !== false
  )
}
export function workerDockNeedsAttention(state: WorkerDockEntry['state']): boolean {
  return state === 'failed' || state === 'unexpected' || state === 'needs-you'
}
export function compareWorkerDockEntries(
  a: Pick<WorkerDockEntry, 'id' | 'state' | 'changedAt'>,
  b: Pick<WorkerDockEntry, 'id' | 'state' | 'changedAt'>
): number {
  return (
    Number(workerDockNeedsAttention(b.state)) - Number(workerDockNeedsAttention(a.state)) ||
    Number(a.changedAt === null) - Number(b.changedAt === null) ||
    (b.changedAt ?? 0) - (a.changedAt ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

export const WorkerDockResultRead = lazyZodSchema(() =>
  WorkerDockSource.extend({ dispatch: z.string() })
)
/** `requestId` is unread here; clients keep sending it because older hosts still require it. */
export const WorkerDockStop = lazyZodSchema(() =>
  WorkerDockResultRead.extend({
    requestId: z.string().min(1).optional()
  })
)
