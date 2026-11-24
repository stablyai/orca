import type { GitBranchLineTotal } from './git-status-types'

export type GitStatusLineStatsEntry = {
  path?: unknown
  status?: unknown
  area?: unknown
  oldPath?: unknown
  conflictKind?: unknown
  conflictStatus?: unknown
  conflictStatusSource?: unknown
  submodule?: {
    commitChanged?: boolean
    trackedChanges?: boolean
    untrackedChanges?: boolean
  }
  added?: number
  removed?: number
}

export type CachedLineStats = {
  identity: string
  storedAt: number
  stats: { added?: number; removed?: number }[]
  // Branch totals share the entry snapshot's reuse lifecycle.
  branchLineTotal?: GitBranchLineTotal
  branchLineTotalUnavailable?: string
  // Reuse-only backfills must not overwrite a newer total outcome.
  branchLineTotalWriteSeq?: number
}

export function createInputIdentity(
  head: string | undefined,
  entries: GitStatusLineStatsEntry[]
): string {
  return JSON.stringify([
    head ?? null,
    entries.map((entry) => [
      entry.path,
      entry.status,
      entry.area,
      entry.oldPath ?? null,
      entry.conflictKind ?? null,
      entry.conflictStatus ?? null,
      entry.conflictStatusSource ?? null,
      entry.submodule?.commitChanged ?? null,
      entry.submodule?.trackedChanges ?? null,
      entry.submodule?.untrackedChanges ?? null
    ])
  ])
}

export function createGitStatusLineStatsSnapshot(
  input: {
    head?: string
    entries: GitStatusLineStatsEntry[]
    branchLineTotal?: GitBranchLineTotal
    branchLineTotalUnavailable?: string
  },
  previous: CachedLineStats | undefined,
  beginSeq: number,
  storedAt: number
): CachedLineStats {
  const identity = createInputIdentity(input.head, input.entries)
  // Preserve late totals on unchanged snapshots, unless a newer result invalidates them.
  const unchanged = previous?.identity === identity ? previous : undefined
  const totalIsCurrent = beginSeq >= (unchanged?.branchLineTotalWriteSeq ?? 0)
  const incomingTotal = totalIsCurrent ? input.branchLineTotal : undefined
  const incomingUnavailable = totalIsCurrent ? input.branchLineTotalUnavailable : undefined
  const branchLineTotal =
    incomingTotal ??
    (unchanged?.branchLineTotal?.mergeBase !== incomingUnavailable
      ? unchanged?.branchLineTotal
      : undefined)
  const branchLineTotalUnavailable =
    incomingUnavailable ??
    (unchanged?.branchLineTotalUnavailable !== incomingTotal?.mergeBase
      ? unchanged?.branchLineTotalUnavailable
      : undefined)
  const branchLineTotalWriteSeq =
    incomingTotal !== undefined || incomingUnavailable !== undefined
      ? beginSeq
      : unchanged?.branchLineTotalWriteSeq
  return {
    identity,
    storedAt,
    stats: input.entries.map((entry) => ({
      ...(entry.added === undefined ? {} : { added: entry.added }),
      ...(entry.removed === undefined ? {} : { removed: entry.removed })
    })),
    ...(branchLineTotal === undefined ? {} : { branchLineTotal }),
    ...(branchLineTotalUnavailable === undefined ? {} : { branchLineTotalUnavailable }),
    ...(branchLineTotalWriteSeq === undefined ? {} : { branchLineTotalWriteSeq })
  }
}
