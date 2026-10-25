import { useCallback, useMemo, useState } from 'react'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import {
  bulkStageRuntimeGitPaths,
  bulkUnstageRuntimeGitPaths,
  stageRuntimeGitWorktreeScope
} from '@/runtime/runtime-git-working-tree-client'
import {
  getStageAllPaths,
  getUnstageAllPaths,
  isStageableStatusEntry
} from './discard-all-sequence'
import type {
  SourceControlDisplaySectionId,
  SourceControlEntryGroups
} from '../listing/section-order'
import type { FlatEntry } from '../listing/use-selection'
import type { GitStageWorktreeScope } from '../../../../../../shared/git-stage-worktree-scope'

/** Handlers run with void; catch Git failures to avoid silent unhandled rejections. */
function reportBulkMutationFailure(error: unknown): void {
  console.error('[SourceControl] bulk stage/unstage failed', error)
  toast.error(
    translate(
      'auto.components.right.sidebar.use.source.control.bulk.actions.2f67630884',
      'Bulk stage/unstage failed'
    ),
    { description: readIpcErrorMessage(error) }
  )
}

export function useSourceControlBulkActions({
  selectedKeys,
  flatEntriesByKey,
  activeRepoTarget,
  activeWorktreeId,
  worktreePath,
  grouped,
  isStatusTruncated,
  clearSelection,
  refreshActiveGitStatusAfterMutation
}: {
  selectedKeys: ReadonlySet<string>
  flatEntriesByKey: ReadonlyMap<string, FlatEntry>
  activeRepoTarget: RuntimeClientTarget | null
  activeWorktreeId: string | null
  worktreePath: string | null
  grouped: SourceControlEntryGroups
  /** The status read hit its entry cap, so `grouped` holds only the first rows. */
  isStatusTruncated: boolean
  clearSelection: () => void
  refreshActiveGitStatusAfterMutation: () => Promise<void>
}) {
  const [isExecutingBulk, setIsExecutingBulk] = useState(false)
  // Reset during render so switches never paint the previous worktree's busy state.
  const [bulkActionsWorktreeId, setBulkActionsWorktreeId] = useState(activeWorktreeId)
  if (bulkActionsWorktreeId !== activeWorktreeId) {
    setBulkActionsWorktreeId(activeWorktreeId)
    setIsExecutingBulk(false)
  }
  const selectedEntries = useMemo(
    () =>
      Array.from(selectedKeys)
        .map((key) => flatEntriesByKey.get(key))
        .filter((entry): entry is FlatEntry => Boolean(entry)),
    [selectedKeys, flatEntriesByKey]
  )

  const bulkStagePaths = useMemo(
    () =>
      selectedEntries
        .filter((entry) => isStageableStatusEntry(entry.entry))
        .map((entry) => entry.entry.path),
    [selectedEntries]
  )

  const bulkUnstagePaths = useMemo(
    () => getUnstageAllPaths(selectedEntries.map((entry) => entry.entry)),
    [selectedEntries]
  )

  const selectedKeySet = selectedKeys

  const handleBulkStage = useCallback(async () => {
    if (!worktreePath || isExecutingBulk || bulkStagePaths.length === 0) {
      return
    }
    setIsExecutingBulk(true)
    try {
      const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
      await bulkStageRuntimeGitPaths(
        {
          // Route staging through workspace ownership rather than focused runtime.
          target: requireGitOwnerTarget(activeRepoTarget),
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        bulkStagePaths
      )
      await refreshActiveGitStatusAfterMutation()
      clearSelection()
    } catch (error) {
      reportBulkMutationFailure(error)
    } finally {
      setIsExecutingBulk(false)
    }
  }, [
    activeRepoTarget,
    worktreePath,
    bulkStagePaths,
    clearSelection,
    activeWorktreeId,
    isExecutingBulk,
    refreshActiveGitStatusAfterMutation
  ])

  const handleBulkUnstage = useCallback(async () => {
    if (!worktreePath || isExecutingBulk || bulkUnstagePaths.length === 0) {
      return
    }
    setIsExecutingBulk(true)
    try {
      const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
      await bulkUnstageRuntimeGitPaths(
        {
          // Route unstaging through workspace ownership rather than focused runtime.
          target: requireGitOwnerTarget(activeRepoTarget),
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        },
        bulkUnstagePaths
      )
      await refreshActiveGitStatusAfterMutation()
      clearSelection()
    } catch (error) {
      reportBulkMutationFailure(error)
    } finally {
      setIsExecutingBulk(false)
    }
  }, [
    activeRepoTarget,
    worktreePath,
    bulkUnstagePaths,
    clearSelection,
    activeWorktreeId,
    isExecutingBulk,
    refreshActiveGitStatusAfterMutation
  ])

  // Scopes replace explicit paths; only the host can enumerate changes beyond the listing cap.
  const stagePaths = useCallback(
    async (paths: readonly string[], scope?: GitStageWorktreeScope) => {
      if (!worktreePath || isExecutingBulk || (paths.length === 0 && !scope)) {
        return
      }
      setIsExecutingBulk(true)
      try {
        const context = {
          // Route staging through workspace ownership rather than focused runtime.
          target: requireGitOwnerTarget(activeRepoTarget),
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId: getConnectionId(activeWorktreeId ?? null) ?? undefined
        }
        await (scope
          ? stageRuntimeGitWorktreeScope(context, scope)
          : bulkStageRuntimeGitPaths(context, [...paths]))
        await refreshActiveGitStatusAfterMutation()
        clearSelection()
      } catch (error) {
        reportBulkMutationFailure(error)
      } finally {
        setIsExecutingBulk(false)
      }
    },
    [
      activeRepoTarget,
      activeWorktreeId,
      clearSelection,
      isExecutingBulk,
      refreshActiveGitStatusAfterMutation,
      worktreePath
    ]
  )

  const handleStageAllPaths = useCallback(
    (paths: readonly string[]) => stagePaths(paths),
    [stagePaths]
  )

  // Resolve all on the host because a capped listing omits changes.
  const handleStageSectionPaths = useCallback(
    (sectionId: SourceControlDisplaySectionId, paths: readonly string[]) =>
      stagePaths(paths, isStatusTruncated && sectionId === 'unstaged' ? 'all' : undefined),
    [isStatusTruncated, stagePaths]
  )

  const handleUnstagePaths = useCallback(
    async (paths: readonly string[]) => {
      if (!worktreePath || isExecutingBulk || paths.length === 0) {
        return
      }
      setIsExecutingBulk(true)
      try {
        const connectionId = getConnectionId(activeWorktreeId ?? null) ?? undefined
        await bulkUnstageRuntimeGitPaths(
          {
            // Route unstaging through workspace ownership rather than focused runtime.
            target: requireGitOwnerTarget(activeRepoTarget),
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId
          },
          [...paths]
        )
        await refreshActiveGitStatusAfterMutation()
        clearSelection()
      } catch (error) {
        reportBulkMutationFailure(error)
      } finally {
        setIsExecutingBulk(false)
      }
    },
    [
      activeRepoTarget,
      activeWorktreeId,
      clearSelection,
      isExecutingBulk,
      refreshActiveGitStatusAfterMutation,
      worktreePath
    ]
  )

  // Stage is deliberately absent from DropdownActionKind, so it bypasses that dispatcher.
  const handleStageAllPrimary = useCallback(async (): Promise<void> => {
    const filePaths = [
      ...getStageAllPaths(grouped.unstaged, 'unstaged'),
      ...getStageAllPaths(grouped.untracked, 'untracked')
    ]
    await stagePaths(filePaths, isStatusTruncated ? 'all' : undefined)
  }, [grouped, isStatusTruncated, stagePaths])

  // Stage hidden changes after the capped prefix leaves no usable row/primary Stage All action.
  const handleStageWorktreeChanges = useCallback(() => stagePaths([], 'all'), [stagePaths])

  return {
    isExecutingBulk,
    setIsExecutingBulk,
    bulkStagePaths,
    bulkUnstagePaths,
    selectedKeySet,
    handleBulkStage,
    handleBulkUnstage,
    handleStageAllPaths,
    handleStageSectionPaths,
    handleUnstagePaths,
    handleStageAllPrimary,
    handleStageWorktreeChanges
  }
}
