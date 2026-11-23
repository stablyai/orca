import { z } from 'zod'
import { CrewParty } from '../orchestration-crew'

export const WorkerDockSource = z.object({ party: CrewParty })
export const WorkerDockSubscribe = WorkerDockSource.extend({
  includeRows: z.boolean().optional(),
  /** Only current work: live workers and recent, unresolved failures (see workerDockCurrentSql). */
  currentOnly: z.boolean().optional()
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
export const WorkerDockResultRef = z.object({
  name: z.string().default('Worker'),
  title: z.string().default(''),
  summary: z.string().default(''),
  outcome: z.enum(['succeeded', 'failed', 'stopped', 'unexpected']).optional(),
  dispatchId: z.string(),
  id: z.string(),
  at: z.number().nullable(),
  settlement: z.string()
})
export type WorkerDockResultRef = z.infer<typeof WorkerDockResultRef>
export function compareWorkerDockResultRefs(
  a: Pick<WorkerDockResultRef, 'at' | 'dispatchId'>,
  b: Pick<WorkerDockResultRef, 'at' | 'dispatchId'>
): number {
  return (
    Number(a.at === null) - Number(b.at === null) ||
    (b.at ?? 0) - (a.at ?? 0) ||
    (a.dispatchId < b.dispatchId ? -1 : a.dispatchId > b.dispatchId ? 1 : 0)
  )
}
export function oldestWorkerDockResultRef(refs: readonly WorkerDockResultRef[]) {
  let oldest: WorkerDockResultRef | undefined
  for (const ref of refs) {
    if (!oldest || compareWorkerDockResultRefs(ref, oldest) > 0) {
      oldest = ref
    }
  }
  return oldest
}
export const WorkerDockSnapshot = z.object({
  results: z.array(WorkerDockResultRef).default([]),
  revision: z.number(),
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

export const WorkerDockResultsRead = WorkerDockSource.extend({
  before: WorkerDockResultRef.optional()
})
