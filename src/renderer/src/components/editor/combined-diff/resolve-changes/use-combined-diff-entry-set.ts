import React from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiffSection } from '../../diff-section-types'
import type { CombinedDiffFileTreeMode } from './combined-diff-section-identity'
import {
  getCombinedBranchEntries,
  getCombinedUncommittedEntries,
  resolveCombinedUncommittedSnapshotEntries,
  shouldAutoReloadCombinedDiffFromGitStatus
} from './combined-diff-entries'
import { getRetainedResolvedSnapshotEntries } from './combined-diff-git-status-signature'

// Why: stable identities so the store selectors don't resubscribe on every empty read.
export const EMPTY_GIT_STATUS_ENTRIES: GitStatusEntry[] = []
export const EMPTY_GIT_BRANCH_ENTRIES: GitBranchChangeEntry[] = []

export type CombinedDiffEntrySet = {
  allEntries: (GitStatusEntry | GitBranchChangeEntry)[]
  branchCompare: NonNullable<OpenFile['branchCompare']> | null
  commitCompare: NonNullable<OpenFile['commitCompare']> | null
  commitEntries: GitBranchChangeEntry[]
  entries: (GitStatusEntry | GitBranchChangeEntry)[]
  entrySignature: string
  hasUncommittedEntriesSnapshot: boolean
  isAllMode: boolean
  isBranchMode: boolean
  isCommitMode: boolean
  renderableBranchEntries: GitBranchChangeEntry[]
  shouldAutoReloadFromGitStatus: boolean
  treeMode: CombinedDiffFileTreeMode
  uncommittedEntries: GitStatusEntry[]
}

export function useCombinedDiffEntrySet({
  file,
  gitStatusEntries,
  liveBranchEntries,
  sectionsRef
}: {
  file: OpenFile
  gitStatusEntries: GitStatusEntry[]
  liveBranchEntries: GitBranchChangeEntry[]
  sectionsRef: React.RefObject<DiffSection[]>
}): CombinedDiffEntrySet {
  const isBranchMode = file.diffSource === 'combined-branch'
  const isCommitMode = file.diffSource === 'combined-commit'
  const isAllMode = file.diffSource === 'combined-all'
  const branchCompare =
    file.branchCompare?.baseOid && file.branchCompare.headOid && file.branchCompare.mergeBase
      ? file.branchCompare
      : null
  const commitCompare = file.commitCompare?.commitOid ? file.commitCompare : null

  // Why: prefer the tab-open snapshot so a commit changing gitStatusByWorktree doesn't rebuild sections and lose loaded content.
  const snapshotEntries = React.useMemo(
    () => file.uncommittedEntriesSnapshot?.filter((e) => e.conflictStatus !== 'unresolved'),
    [file.uncommittedEntriesSnapshot]
  )
  const uncommittedEntries = React.useMemo(() => {
    if (!snapshotEntries) {
      return getCombinedUncommittedEntries(gitStatusEntries, file.combinedAreaFilter)
    }
    // Why: row load-state changes must not rebuild the snapshot list; the ref is consulted only when live Git status changes.
    return resolveCombinedUncommittedSnapshotEntries(
      snapshotEntries,
      gitStatusEntries,
      getRetainedResolvedSnapshotEntries(sectionsRef.current)
    )
  }, [snapshotEntries, gitStatusEntries, file.combinedAreaFilter, sectionsRef])
  const branchEntries = React.useMemo<GitBranchChangeEntry[]>(() => {
    return getCombinedBranchEntries(file.branchEntriesSnapshot, liveBranchEntries)
  }, [file.branchEntriesSnapshot, liveBranchEntries])
  const renderableBranchEntries = React.useMemo(
    () => (branchCompare ? branchEntries : []),
    [branchCompare, branchEntries]
  )
  const commitEntries = React.useMemo<GitBranchChangeEntry[]>(
    () => file.commitEntriesSnapshot ?? [],
    [file.commitEntriesSnapshot]
  )
  const allEntries = React.useMemo(
    () => [...uncommittedEntries, ...renderableBranchEntries],
    [renderableBranchEntries, uncommittedEntries]
  )
  const entries = isAllMode
    ? allEntries
    : isBranchMode
      ? renderableBranchEntries
      : isCommitMode
        ? commitEntries
        : uncommittedEntries
  const treeMode = isAllMode
    ? 'all'
    : isBranchMode
      ? 'branch'
      : isCommitMode
        ? 'commit'
        : 'uncommitted'
  const hasUncommittedEntriesSnapshot = file.uncommittedEntriesSnapshot !== undefined
  const shouldAutoReloadFromGitStatus = shouldAutoReloadCombinedDiffFromGitStatus({
    mode: treeMode,
    hasUncommittedEntriesSnapshot
  })
  const entrySignature = React.useMemo(
    () =>
      JSON.stringify({
        mode: file.diffSource,
        areaFilter: file.combinedAreaFilter ?? null,
        compareVersion: file.branchCompare?.compareVersion ?? null,
        commitVersion: file.commitCompare?.compareVersion ?? null,
        compare:
          isBranchMode && branchCompare
            ? {
                baseOid: branchCompare.baseOid,
                headOid: branchCompare.headOid,
                mergeBase: branchCompare.mergeBase
              }
            : null,
        commit:
          isCommitMode && commitCompare
            ? {
                commitOid: commitCompare.commitOid,
                parentOid: commitCompare.parentOid ?? null
              }
            : null,
        entries: entries.map((entry) => ({
          path: entry.path,
          status: entry.status,
          oldPath: entry.oldPath ?? null,
          area: 'area' in entry ? entry.area : null,
          added: 'added' in entry ? (entry.added ?? null) : null,
          removed: 'removed' in entry ? (entry.removed ?? null) : null
        }))
      }),
    [
      branchCompare,
      commitCompare,
      entries,
      file.branchCompare?.compareVersion,
      file.combinedAreaFilter,
      file.commitCompare?.compareVersion,
      file.diffSource,
      isBranchMode,
      isCommitMode
    ]
  )

  return {
    allEntries,
    branchCompare,
    commitCompare,
    commitEntries,
    entries,
    entrySignature,
    hasUncommittedEntriesSnapshot,
    isAllMode,
    isBranchMode,
    isCommitMode,
    renderableBranchEntries,
    shouldAutoReloadFromGitStatus,
    treeMode,
    uncommittedEntries
  }
}
