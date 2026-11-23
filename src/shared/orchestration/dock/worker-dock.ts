import { z } from 'zod'
import { CrewParty } from '../orchestration-crew'

export const WorkerDockSource = z.object({ party: CrewParty })
export const WorkerDockSubscribe = WorkerDockSource.extend({
  includeRows: z.boolean().optional(),
  /** Only current work: live workers and recent, unresolved failures (see workerDockCurrentRowsSql). */
  currentOnly: z.boolean().optional(),
  activeOnly: z.boolean().optional()
})
export const WorkerDockState = z.enum([
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
export const WorkerDockEntry = z.object({
  kind: z.enum(['worker', 'agent', 'command', 'workflow', 'monitor', 'unknown']).default('worker'),
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
  settlement: z.string().nullable(),
  resultId: z.string().nullable(),
  stoppable: z.boolean(),
  ownerActionsAvailable: z.boolean().default(true)
})
export type WorkerDockEntry = z.infer<typeof WorkerDockEntry>
export const WorkerDockIdentity = WorkerDockEntry.pick({
  id: true,
  dispatchId: true,
  state: true,
  changedAt: true,
  ownerActionsAvailable: true,
  settlement: true
}).extend({ kind: WorkerDockEntry.shape.kind.optional(), hasModel: z.boolean().default(false) })
export const WorkerDockSnapshot = z.object({
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
export type WorkerDockSnapshot = z.infer<typeof WorkerDockSnapshot>
export const WorkerDockRead = WorkerDockSubscribe.extend({
  seed: z.boolean().optional(),
  revision: z.number().optional(),
  anchor: z.string().optional(),
  direction: z.enum(['before', 'after', 'around']).default('around')
})
export const WorkerDockAcknowledge = WorkerDockSource.extend({
  settlements: z.array(z.object({ dispatchId: z.string(), settlement: z.string() })).max(1000),
  acknowledged: z.boolean()
})
export const WorkerDockResult = z.object({
  id: z.string(),
  dispatchId: z.string(),
  name: z.string(),
  title: z.string(),
  outcome: z.enum(['succeeded', 'failed', 'stopped', 'unexpected']),
  body: z.string(),
  at: z.number().nullable(),
  settlement: z.string(),
  acknowledged: z.boolean(),
  ownerActionsAvailable: z.boolean().default(true)
})
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

export const WorkerDockResultRead = WorkerDockSource.extend({ dispatch: z.string() })
export const WorkerDockStop = WorkerDockResultRead.extend({ requestId: z.string().min(1) })
