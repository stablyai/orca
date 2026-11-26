import type { WorkerDockEntry } from '../../../../../../../shared/orchestration/dock/worker-dock'

/** The glyph a worker card row draws: one per state, and none of them a "Status unavailable" label. */
export type WorkerDockGlyph = 'ask' | 'failed' | 'running' | 'queued' | 'done'

export function workerDockGlyph(row: {
  state: WorkerDockEntry['state']
  retired?: boolean
}): WorkerDockGlyph {
  if (row.retired) {
    return 'done'
  }
  switch (row.state) {
    case 'needs-you':
      return 'ask'
    case 'failed':
    case 'unexpected':
      return 'failed'
    case 'starting':
    case 'running':
    case 'saving':
    case 'stopping':
      return 'running'
    case 'waiting':
    case 'coordinator':
    case 'unavailable':
      return 'queued'
    case 'idle':
      return 'done'
  }
}

// A person waiting outranks a failure, which outranks live work; finished work sinks to the end.
const TIER: Record<WorkerDockGlyph, number> = { ask: 0, failed: 1, running: 2, queued: 3, done: 4 }

/** The card's order, and the pill's pick (its first row): needs-you, failed, running, queued, done;
 *  within a tier the most recently changed first, and a row with no time after one that has it. */
export function compareWorkerDockCardRows(
  a: { id: string; state: WorkerDockEntry['state']; changedAt?: number | null; retired?: boolean },
  b: { id: string; state: WorkerDockEntry['state']; changedAt?: number | null; retired?: boolean }
): number {
  const aChanged = a.changedAt ?? null
  const bChanged = b.changedAt ?? null
  return (
    TIER[workerDockGlyph(a)] - TIER[workerDockGlyph(b)] ||
    Number(aChanged === null) - Number(bChanged === null) ||
    (bChanged ?? 0) - (aChanged ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}
