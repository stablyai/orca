import { translate } from '@/i18n/i18n'
import type {
  GitConflictKind,
  GitStatusEntry,
  GitUpstreamStatus
} from '../../../../../../shared/git-status-types'
import type {
  BranchCompareLike,
  BranchCompareSnapshot,
  CommitCompareLike,
  CommitCompareSnapshot,
  OpenConflictMetadata,
  OpenFile
} from '../types/open-file'

export function getCompareVersion(
  compare: Pick<BranchCompareLike, 'baseOid' | 'headOid' | 'mergeBase'>
): string {
  return [
    compare.baseOid ?? 'no-base',
    compare.headOid ?? 'no-head',
    compare.mergeBase ?? 'no-merge-base'
  ].join(':')
}

export function toBranchCompareSnapshot(compare: BranchCompareLike): BranchCompareSnapshot {
  return {
    baseRef: compare.baseRef,
    baseOid: compare.baseOid,
    compareRef: compare.compareRef,
    headOid: compare.headOid,
    mergeBase: compare.mergeBase,
    compareVersion: getCompareVersion(compare)
  }
}

export function toCommitCompareSnapshot(
  compare: CommitCompareLike,
  subject?: string,
  message?: string
): CommitCompareSnapshot {
  return {
    commitOid: compare.commitOid,
    parentOid: compare.parentOid,
    compareRef: compare.compareRef,
    baseRef: compare.baseRef,
    compareVersion: `${compare.parentOid ?? 'empty-tree'}:${compare.commitOid}`,
    subject:
      subject ??
      ('subject' in compare && typeof compare.subject === 'string' ? compare.subject : undefined),
    message:
      message ??
      ('message' in compare && typeof compare.message === 'string' ? compare.message : undefined)
  }
}

export function toOpenConflictMetadata(entry: GitStatusEntry): OpenConflictMetadata | undefined {
  if (!entry.conflictKind || !entry.conflictStatus || !entry.conflictStatusSource) {
    return undefined
  }

  const hasWorkingTreeFile = entry.status !== 'deleted'
  return hasWorkingTreeFile
    ? {
        kind: 'conflict-editable',
        conflictKind: entry.conflictKind,
        conflictStatus: entry.conflictStatus,
        conflictStatusSource: entry.conflictStatusSource
      }
    : {
        kind: 'conflict-placeholder',
        conflictKind: entry.conflictKind,
        conflictStatus: entry.conflictStatus,
        conflictStatusSource: entry.conflictStatusSource,
        message: translate(
          'auto.store.slices.editor.dcb521ed29',
          'This file is in a conflict state, but no working-tree file is available to edit.'
        ),
        guidance: translate(
          'auto.store.slices.editor.conflictPlaceholderGuidance',
          'Resolve the conflict in Git or restore one side before reopening it.'
        )
      }
}

// Why: conflict state can change (unresolved↔resolved_locally) without the base status changing, so also compare conflict fields.
export function areGitStatusEntriesEqual(prev: GitStatusEntry[], next: GitStatusEntry[]): boolean {
  return (
    prev.length === next.length &&
    prev.every(
      (entry, index) =>
        entry.path === next[index].path &&
        entry.status === next[index].status &&
        entry.area === next[index].area &&
        entry.oldPath === next[index].oldPath &&
        entry.conflictKind === next[index].conflictKind &&
        entry.conflictStatus === next[index].conflictStatus &&
        entry.conflictStatusSource === next[index].conflictStatusSource &&
        entry.added === next[index].added &&
        entry.removed === next[index].removed
    )
  )
}

export function areTrackedConflictMapsEqual(
  prev: Record<string, GitConflictKind>,
  next: Record<string, GitConflictKind>
): boolean {
  const prevKeys = Object.keys(prev)
  const nextKeys = Object.keys(next)
  return prevKeys.length === nextKeys.length && prevKeys.every((key) => prev[key] === next[key])
}

export function areUpstreamStatusesEqual(
  prev: GitUpstreamStatus | undefined,
  next: GitUpstreamStatus
): boolean {
  return (
    prev !== undefined &&
    prev.hasUpstream === next.hasUpstream &&
    prev.upstreamName === next.upstreamName &&
    prev.ahead === next.ahead &&
    prev.behind === next.behind &&
    prev.hasConfiguredPushTarget === next.hasConfiguredPushTarget &&
    prev.behindCommitsArePatchEquivalent === next.behindCommitsArePatchEquivalent
  )
}

export function reconcileOpenFilesForStatus(
  openFiles: OpenFile[],
  worktreeId: string,
  nextEntries: GitStatusEntry[],
  statusIsComplete: boolean
): OpenFile[] {
  const entriesByPath = new Map(nextEntries.map((entry) => [entry.path, entry]))
  let changed = false

  const nextOpenFiles = openFiles.flatMap((file) => {
    if (file.worktreeId !== worktreeId) {
      return [file]
    }

    if (file.mode === 'conflict-review' || file.mode === 'check-details') {
      return [file]
    }

    const entry = entriesByPath.get(file.relativePath)
    if (!file.conflict) {
      return [file]
    }

    // Why: a capped snapshot cannot prove that an omitted conflict was resolved.
    if (!entry && !statusIsComplete) {
      return [file]
    }

    if (!entry || !entry.conflictKind || !entry.conflictStatus || !entry.conflictStatusSource) {
      changed = true
      return file.conflict.kind === 'conflict-placeholder' ? [] : [{ ...file, conflict: undefined }]
    }

    const nextConflict = toOpenConflictMetadata(entry)
    if (!nextConflict) {
      return [file]
    }

    if (
      file.conflict.kind === nextConflict.kind &&
      file.conflict.conflictKind === nextConflict.conflictKind &&
      file.conflict.conflictStatus === nextConflict.conflictStatus &&
      file.conflict.conflictStatusSource === nextConflict.conflictStatusSource &&
      file.conflict.message === nextConflict.message &&
      file.conflict.guidance === nextConflict.guidance
    ) {
      return [file]
    }

    changed = true
    return [{ ...file, conflict: nextConflict }]
  })

  return changed ? nextOpenFiles : openFiles
}
