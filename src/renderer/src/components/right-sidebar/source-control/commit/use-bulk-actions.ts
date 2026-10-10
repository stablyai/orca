import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import {
  bulkStageRuntimeGitPaths,
  bulkUnstageRuntimeGitPaths,
  stageRuntimeGitWorktreeScope,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
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

/** Why: every bulk handler is invoked with `void`, so a Git failure would otherwise be an unhandled rejection with no user feedback. */
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
  activeRepoSettings,
  activeWorktreeId,
  worktreePath,
  grouped,
  isStatusTruncated,
  clearSelection,
  refreshActiveGitStatusAfterMutation
}: {
  selectedKeys: ReadonlySet<string>
  flatEntriesByKey: ReadonlyMap<string, FlatEntry>
  activeRepoSettings: RuntimeGitContext['settings']
  activeWorktreeId: string | null
  worktreePath: string | null
  grouped: SourceControlEntryGroups
  /** The status read hit its entry cap, so `grouped` holds only the first rows. */
  isStatusTruncated: boolean
  clearSelection: () => void
  refreshActiveGitStatusAfterMutation: () => Promise<void>
}) {
  const [isExecutingBulk, setIsExecutingBulk] = useState(false)
  // Why: reset during render so a worktree switch never paints the previous bulk-busy state.
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
          // Why: route staging by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
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
    activeRepoSettings,
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
          // Why: route unstaging by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
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
    activeRepoSettings,
    worktreePath,
    bulkUnstagePaths,
    clearSelection,
    activeWorktreeId,
    isExecutingBulk,
    refreshActiveGitStatusAfterMutation
  ])

  // Why: a scope replaces the paths; a capped listing cannot name every change, so the host resolves them.
  const stagePaths = useCallback(
    async (paths: readonly string[], scope?: GitStageWorktreeScope) => {
      if (!worktreePath || isExecutingBulk || (paths.length === 0 && !scope)) {
        return
      }
      setIsExecutingBulk(true)
      try {
        const context = {
          // Why: route staging by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
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
      activeRepoSettings,
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

  // Why: a capped listing holds only the first rows, so "all" must be resolved by the host.
  const handleStageSectionPaths = useCallback(
    (sectionId: SourceControlDisplaySectionId, paths: readonly string[]) =>
      stagePaths(paths, isStatusTruncated && sectionId === 'unstaged' ? 'tracked' : undefined),
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
            // Why: route unstaging by the repo OWNER host, not the focused runtime.
            settings: activeRepoSettings,
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
      activeRepoSettings,
      activeWorktreeId,
      clearSelection,
      isExecutingBulk,
      refreshActiveGitStatusAfterMutation,
      worktreePath
    ]
  )

  // Why: bypasses handleActionInvoke because that handler is typed to DropdownActionKind and 'stage' is intentionally not in the dropdown union.
  const handleStageAllPrimary = useCallback(async (): Promise<void> => {
    const filePaths = [
      ...getStageAllPaths(grouped.unstaged, 'unstaged'),
      ...getStageAllPaths(grouped.untracked, 'untracked')
    ]
    await stagePaths(filePaths, isStatusTruncated ? 'all' : undefined)
  }, [grouped, isStatusTruncated, stagePaths])

  // Why: once the capped prefix is all staged, no row or primary action can reach the hidden rest.
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
