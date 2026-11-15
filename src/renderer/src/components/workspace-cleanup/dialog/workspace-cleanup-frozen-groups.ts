import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import {
  getWorkspaceCleanupGroup,
  type WorkspaceCleanupGroup
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-groups'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'

/** A row's group and the pass it was admitted in; later passes list after earlier ones. */
export type WorkspaceCleanupFrozenGroup = {
  group: WorkspaceCleanupGroup
  batch: number
  /** The row as first shown; its second line and card hold still until Refresh. */
  candidate: WorkspaceCleanupCandidate
  /** A selected row kept across Refresh: it updates in place once its new evidence settles. */
  carried?: boolean
}

/** What the row shows about local files; a change here is an update waiting for Refresh. */
function getDisplaySignature(candidate: WorkspaceCleanupCandidate): string {
  const { git } = candidate
  return JSON.stringify([
    [...candidate.blockers].sort(),
    git.clean,
    git.dirtyFileCount ?? null,
    git.upstreamAhead,
    git.checkedAt === null,
    git.atRiskLocalFiles?.count ?? null,
    git.atRiskLocalFiles?.samplePaths ?? null
  ])
}
type FrozenGroups = ReadonlyMap<string, WorkspaceCleanupFrozenGroup>

/** A row is admitted once its git answer is in: unknown rows belong to no group yet. */
function isGroupSettled(
  candidate: WorkspaceCleanupCandidate,
  gitChecksDone: boolean,
  gitPendingWorktreeIds: ReadonlySet<string>
): boolean {
  return (
    candidate.git.checkedAt !== null ||
    getWorkspaceCleanupGroup(candidate) === 'cannot-delete' ||
    (gitChecksDone && !gitPendingWorktreeIds.has(candidate.worktreeId))
  )
}

/**
 * Admits newly settled rows as one batch and never moves a row already admitted. A carried
 * (selected through Refresh) row takes its new snapshot once its evidence settles, in the
 * same card and slot.
 */
export function freezeWorkspaceCleanupGroups(
  frozen: FrozenGroups,
  candidates: readonly WorkspaceCleanupCandidate[],
  gitChecksDone: boolean,
  gitPendingWorktreeIds: ReadonlySet<string>
): FrozenGroups {
  let next: Map<string, WorkspaceCleanupFrozenGroup> | null = null
  // Carried rows sit in the first batch after Refresh, so they keep their place among the rows
  // admitted with them instead of jumping to the top of their card.
  let lastBatch = -1
  for (const entry of frozen.values()) {
    if (!entry.carried) {
      lastBatch = Math.max(lastBatch, entry.batch)
    }
  }
  const batch = lastBatch + 1
  for (const candidate of candidates) {
    const identity = getWorkspaceCleanupCandidateIdentity(candidate)
    const admitted = frozen.get(identity)
    if (!isGroupSettled(candidate, gitChecksDone, gitPendingWorktreeIds)) {
      continue
    }
    if (admitted === undefined) {
      next ??= new Map(frozen)
      next.set(identity, { group: getWorkspaceCleanupGroup(candidate), batch, candidate })
    } else if (admitted.carried) {
      next ??= new Map(frozen)
      next.set(identity, { group: admitted.group, batch: admitted.batch, candidate })
    }
  }
  return next ?? frozen
}

const NO_GROUPS: FrozenGroups = new Map()

function carrySelectedGroups(
  previous: FrozenGroups,
  selectedIds: ReadonlySet<string>
): FrozenGroups {
  const carried = new Map<string, WorkspaceCleanupFrozenGroup>()
  for (const [identity, entry] of previous) {
    if (selectedIds.has(identity)) {
      carried.set(identity, { ...entry, batch: 0, carried: true })
    }
  }
  return carried
}

/**
 * Group membership holds while the dialog is open, so a row never changes card under the pointer.
 * A row with no git answer yet is in no group; once known it joins the end of its group.
 * New scan results apply when the dialog opens or the user refreshes.
 */
export function useWorkspaceCleanupFrozenGroups({
  candidates,
  open,
  scanning,
  gitPendingWorktreeIds,
  gitChecksStarted,
  selectedIds
}: {
  candidates: readonly WorkspaceCleanupCandidate[]
  /** Selected rows stay visible through Refresh, so a selection is never hidden or lost. */
  selectedIds: ReadonlySet<string>
  open: boolean
  scanning: boolean
  gitPendingWorktreeIds: ReadonlySet<string>
  /** The git evidence reader has queued its reads, so an empty pending set means done, not not-yet-started. */
  gitChecksStarted: boolean
}): {
  /** Null while the row's group is unknown; such rows are not shown. */
  getFrozenGroup: (candidate: WorkspaceCleanupCandidate) => WorkspaceCleanupFrozenGroup | null
  resetGroups: () => void
  /** Newer evidence exists for rows already shown; it applies on Refresh. */
  updatesAvailable: boolean
} {
  const [epoch, setEpoch] = useState(0)
  const [frozen, setFrozen] = useState<{ epoch: number; groups: FrozenGroups }>({
    epoch: 0,
    groups: NO_GROUPS
  })
  const [wasOpen, setWasOpen] = useState(open)
  // After Refresh the old snapshot stays on screen until the new scan settles; then it is replaced.
  const [refresh, setRefresh] = useState<'idle' | 'await-start' | 'scanning'>('idle')
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setEpoch((current) => current + 1)
    }
  }
  if (refresh === 'await-start' && scanning) {
    setRefresh('scanning')
  } else if (refresh === 'scanning' && !scanning) {
    setRefresh('idle')
  }

  useEffect(() => {
    if (!open || refresh !== 'idle') {
      return
    }
    setFrozen((current) => {
      const base =
        current.epoch === epoch ? current.groups : carrySelectedGroups(current.groups, selectedIds)
      const groups = freezeWorkspaceCleanupGroups(
        base,
        candidates,
        !scanning && gitChecksStarted,
        gitPendingWorktreeIds
      )
      return groups === current.groups && current.epoch === epoch ? current : { epoch, groups }
    })
  }, [
    candidates,
    epoch,
    gitChecksStarted,
    gitPendingWorktreeIds,
    open,
    refresh,
    scanning,
    selectedIds
  ])

  const { groups } = frozen
  const getFrozenGroup = useCallback(
    (candidate: WorkspaceCleanupCandidate) =>
      groups.get(getWorkspaceCleanupCandidateIdentity(candidate)) ?? null,
    [groups]
  )
  const resetGroups = useCallback(() => {
    setEpoch((current) => current + 1)
    setRefresh('await-start')
  }, [])
  const updatesAvailable = useMemo(
    () =>
      candidates.some((candidate) => {
        const shown = groups.get(getWorkspaceCleanupCandidateIdentity(candidate))
        return (
          shown !== undefined &&
          getDisplaySignature(shown.candidate) !== getDisplaySignature(candidate)
        )
      }),
    [candidates, groups]
  )
  return useMemo(
    () => ({ getFrozenGroup, resetGroups, updatesAvailable }),
    [getFrozenGroup, resetGroups, updatesAvailable]
  )
}
