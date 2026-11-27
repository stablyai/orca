import { create } from 'zustand'
import type { WorkspaceCleanupCandidate } from '../../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import type { WorkspaceCleanupFailure } from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'

/** `provisional` is a timed-out delete whose real outcome has not arrived; it reads as still deleting. */
export type WorkspaceCleanupRunRowStatus =
  | 'waiting'
  | 'deleting'
  | 'provisional'
  | 'deleted'
  | 'failed'

export type WorkspaceCleanupRunRow = {
  identity: string
  candidate: WorkspaceCleanupCandidate
  status: WorkspaceCleanupRunRowStatus
  /** Host-qualified failure with its action facts (e.g. canDeleteAnyway); set only while failed. */
  failure: WorkspaceCleanupFailure | null
  /** Bumped by each retry; settlements for an earlier attempt of this row are dropped. */
  attempt: number
}

/** Identities a batch owns, each with the attempt it started; the batch may only write those. */
export type WorkspaceCleanupRunAttempts = ReadonlyMap<string, number>

export type WorkspaceCleanupRun = {
  /** Fences callbacks: a settlement from an older run or a dismissed one never touches this run. */
  id: number
  rows: readonly WorkspaceCleanupRunRow[]
}

const UNSETTLED: ReadonlySet<WorkspaceCleanupRunRowStatus> = new Set([
  'waiting',
  'deleting',
  'provisional'
])

/** Running until every row is terminal, so a provisional row keeps the run open. */
export function getWorkspaceCleanupRunPhase(run: WorkspaceCleanupRun): 'running' | 'finished' {
  return run.rows.some((row) => UNSETTLED.has(row.status)) ? 'running' : 'finished'
}

type WorkspaceCleanupRunStore = {
  run: WorkspaceCleanupRun | null
  startRun: (candidates: readonly WorkspaceCleanupCandidate[]) => {
    runId: number
    attempts: WorkspaceCleanupRunAttempts
  }
  /** Puts one row back to deleting inside the current run, or starts a one-row run when none exists. */
  beginRowRetry: (candidate: WorkspaceCleanupCandidate) => {
    runId: number
    attempts: WorkspaceCleanupRunAttempts
  }
  markRowDeleting: (runId: number, attempts: WorkspaceCleanupRunAttempts, identity: string) => void
  markRowProvisional: (
    runId: number,
    attempts: WorkspaceCleanupRunAttempts,
    identity: string
  ) => void
  markRowsDeleted: (
    runId: number,
    attempts: WorkspaceCleanupRunAttempts,
    identities: readonly string[]
  ) => void
  markRowFailed: (
    runId: number,
    attempts: WorkspaceCleanupRunAttempts,
    identity: string,
    failure: WorkspaceCleanupFailure
  ) => void
  /** A waiting or deleting row left once its batch has reported can never finish; fail it. */
  settleUnfinishedRows: (runId: number, attempts: WorkspaceCleanupRunAttempts) => void
  /** Gives up waiting on one attempt's row whose outcome never arrived. */
  expireProvisionalRow: (
    runId: number,
    attempts: WorkspaceCleanupRunAttempts,
    identity: string,
    message: string
  ) => void
  dismissRun: (runId?: number) => void
}

let nextRunId = 0

/** Applies `update` to rows the batch owns at its own attempt; anything else is a stale write. */
function updateOwnedRows(
  state: { run: WorkspaceCleanupRun | null },
  runId: number,
  attempts: WorkspaceCleanupRunAttempts,
  identities: ReadonlySet<string> | null,
  update: (row: WorkspaceCleanupRunRow) => WorkspaceCleanupRunRow
): { run: WorkspaceCleanupRun | null } {
  const { run } = state
  if (run === null || run.id !== runId) {
    return state
  }
  let changed = false
  const rows = run.rows.map((row) => {
    if (
      attempts.get(row.identity) !== row.attempt ||
      (identities !== null && !identities.has(row.identity))
    ) {
      return row
    }
    const next = update(row)
    changed ||= next !== row
    return next
  })
  return changed ? { run: { ...run, rows } } : state
}

function createRow(
  candidate: WorkspaceCleanupCandidate,
  status: WorkspaceCleanupRunRowStatus,
  attempt: number
): WorkspaceCleanupRunRow {
  return {
    identity: getWorkspaceCleanupCandidateIdentity(candidate),
    candidate,
    status,
    failure: null,
    attempt
  }
}

const attemptsOf = (run: WorkspaceCleanupRun): WorkspaceCleanupRunAttempts =>
  new Map(run.rows.map((row) => [row.identity, row.attempt]))

/** One in-memory delete run: the dialog step, the corner card and the Settings nav all read it. */
export const useWorkspaceCleanupRunStore = create<WorkspaceCleanupRunStore>()((set, get) => ({
  run: null,
  startRun: (candidates) => {
    nextRunId += 1
    const run = {
      id: nextRunId,
      rows: candidates.map((candidate) => createRow(candidate, 'waiting', 1))
    }
    set({ run })
    return { runId: run.id, attempts: attemptsOf(run) }
  },
  beginRowRetry: (candidate) => {
    const { run } = get()
    const identity = getWorkspaceCleanupCandidateIdentity(candidate)
    const existing = run?.rows.find((row) => row.identity === identity)
    if (run === null || !existing) {
      nextRunId += 1
      const fresh = { id: nextRunId, rows: [createRow(candidate, 'deleting', 1)] }
      set({ run: fresh })
      return { runId: fresh.id, attempts: attemptsOf(fresh) }
    }
    const next = {
      ...run,
      rows: run.rows.map((row) =>
        row === existing
          ? { ...row, status: 'deleting' as const, failure: null, attempt: row.attempt + 1 }
          : row
      )
    }
    set({ run: next })
    return { runId: next.id, attempts: new Map([[identity, existing.attempt + 1]]) }
  },
  markRowDeleting: (runId, attempts, identity) =>
    set((state) =>
      updateOwnedRows(state, runId, attempts, new Set([identity]), (row) =>
        row.status === 'deleted' || row.status === 'deleting'
          ? row
          : { ...row, status: 'deleting', failure: null }
      )
    ),
  markRowProvisional: (runId, attempts, identity) =>
    set((state) =>
      updateOwnedRows(state, runId, attempts, new Set([identity]), (row) =>
        row.status === 'deleted' || row.status === 'provisional'
          ? row
          : { ...row, status: 'provisional', failure: null }
      )
    ),
  markRowsDeleted: (runId, attempts, identities) =>
    set((state) =>
      updateOwnedRows(state, runId, attempts, new Set(identities), (row) =>
        row.status === 'deleted' ? row : { ...row, status: 'deleted', failure: null }
      )
    ),
  markRowFailed: (runId, attempts, identity, failure) =>
    set((state) =>
      updateOwnedRows(state, runId, attempts, new Set([identity]), (row) =>
        row.status === 'deleted' ? row : { ...row, status: 'failed', failure }
      )
    ),
  settleUnfinishedRows: (runId, attempts) =>
    set((state) =>
      updateOwnedRows(state, runId, attempts, null, (row) =>
        row.status === 'waiting' || row.status === 'deleting' ? { ...row, status: 'failed' } : row
      )
    ),
  expireProvisionalRow: (runId, attempts, identity, message) =>
    set((state) =>
      updateOwnedRows(state, runId, attempts, new Set([identity]), (row) =>
        row.status === 'provisional'
          ? {
              ...row,
              status: 'failed',
              failure: {
                worktreeId: row.candidate.worktreeId,
                displayName: row.candidate.displayName,
                message
              }
            }
          : row
      )
    ),
  dismissRun: (runId) =>
    set((state) => (runId === undefined || state.run?.id === runId ? { run: null } : state))
}))

export type WorkspaceCleanupRunCounts = {
  total: number
  deleted: number
  failed: number
  /** Rows no longer waiting or deleting; drives the progress bar. */
  settled: number
}

export function getWorkspaceCleanupRunCounts(run: WorkspaceCleanupRun): WorkspaceCleanupRunCounts {
  let deleted = 0
  let failed = 0
  for (const row of run.rows) {
    if (row.status === 'deleted') {
      deleted += 1
    } else if (row.status === 'failed') {
      failed += 1
    }
  }
  return { total: run.rows.length, deleted, failed, settled: deleted + failed }
}
