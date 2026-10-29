import { useCallback, useState } from 'react'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { basename } from '@/lib/path'
import { bulkUnstageRuntimeGitPaths } from '@/runtime/runtime-git-working-tree-client'
import { translate } from '@/i18n/i18n'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import {
  getDiscardAllPaths,
  runDiscardAllForArea,
  type DiscardAllArea
} from '../../../../../../shared/source-control-discard-all-sequence'
import { discardDeletesEntryFile } from './discard-confirmation'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import {
  dismissSourceControlEntryFailureToast,
  showSourceControlEntryFailureToast
} from './source-control-entry-failure-toast'
import type { PendingDiscardConfirmation } from './discard-dialog'
import type { SourceControlEntryGroups } from '../../../../../../shared/source-control-section-order'

export function useSourceControlDiscardConfirmation({
  activeRepoTarget,
  activeWorktreeId,
  worktreePath,
  grouped,
  isExecutingBulk,
  setIsExecutingBulk,
  clearSelection,
  discardMany,
  discardSingle,
  refreshActiveGitStatusAfterMutation
}: {
  activeRepoTarget: RuntimeClientTarget | null
  activeWorktreeId: string | null
  worktreePath: string | null
  grouped: SourceControlEntryGroups
  isExecutingBulk: boolean
  setIsExecutingBulk: (value: boolean) => void
  clearSelection: () => void
  discardMany: (paths: string[]) => Promise<void>
  discardSingle: (path: string) => Promise<void>
  refreshActiveGitStatusAfterMutation: () => Promise<void>
}) {
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscardConfirmation | null>(null)
  // Reset during render so a worktree switch cannot paint its predecessor's confirmation.
  const [pendingDiscardWorktreeId, setPendingDiscardWorktreeId] = useState(activeWorktreeId)
  if (pendingDiscardWorktreeId !== activeWorktreeId) {
    setPendingDiscardWorktreeId(activeWorktreeId)
    setPendingDiscard(null)
  }

  const handleDiscard = useCallback(
    async (entry: GitStatusEntry): Promise<void> => {
      // Catch only discard; later refresh failure must not claim a successful discard failed.
      try {
        await discardSingle(entry.path)
      } catch (error) {
        console.error('[SourceControl] discard failed', error)
        // Bulk callers aggregate discardSingle failures into their own single toast.
        showSourceControlEntryFailureToast({
          operation: 'discard',
          filePath: entry.path,
          deletesFile: discardDeletesEntryFile(entry),
          error,
          worktreeId: activeWorktreeId,
          worktreeName: worktreePath ? basename(worktreePath) : null
        })
        return
      }
      dismissSourceControlEntryFailureToast(activeWorktreeId)
      await refreshActiveGitStatusAfterMutation()
    },
    [activeWorktreeId, discardSingle, refreshActiveGitStatusAfterMutation, worktreePath]
  )

  // Bulk discard preserves unresolved/local resolutions; shared sequencing also supports older SSH per-file fallback.
  const handleRevertAllInArea = useCallback(
    async (area: DiscardAllArea, confirmedPaths?: readonly string[]) => {
      if (!worktreePath || !activeWorktreeId || isExecutingBulk) {
        return
      }
      const paths = confirmedPaths ? [...confirmedPaths] : getDiscardAllPaths(grouped[area], area)
      if (paths.length === 0) {
        return
      }
      setIsExecutingBulk(true)
      try {
        const connectionId = getConnectionId(activeWorktreeId) ?? undefined
        // Aggregate per-file errors into one toast rather than spamming partial failures.
        const errors: unknown[] = []
        const result = await runDiscardAllForArea(area, paths, {
          bulkUnstage: (filePaths) =>
            bulkUnstageRuntimeGitPaths(
              {
                // Route unstaging through workspace ownership rather than focused runtime.
                target: requireGitOwnerTarget(activeRepoTarget),
                worktreeId: activeWorktreeId,
                worktreePath,
                connectionId
              },
              filePaths
            ),
          discardMany,
          discardOne: discardSingle,
          onError: (error) => {
            errors.push(error)
            console.error('[SourceControl] discard-all failure', error)
          }
        })
        if (result.aborted) {
          toast.error(
            translate(
              'auto.components.right.sidebar.SourceControl.a5e5a11090',
              'Discard all failed — unable to unstage files before discard'
            ),
            { description: readIpcErrorMessage(errors[0]) }
          )
        } else if (result.failed.length > 0) {
          // Limit bulk failures to the first error and sample paths so the toast stays readable.
          const firstMsg = readIpcErrorMessage(errors[0])
          const sample = result.failed.slice(0, 3).join(', ')
          const hiddenCount = result.failed.length - 3
          const samplePaths =
            hiddenCount > 0
              ? hiddenCount === 1
                ? translate(
                    'auto.components.right.sidebar.SourceControl.discardFailedSampleMore_one',
                    '{{paths}}, +{{count}} more',
                    { paths: sample, count: hiddenCount }
                  )
                : translate(
                    'auto.components.right.sidebar.SourceControl.discardFailedSampleMore_other',
                    '{{paths}}, +{{count}} more',
                    { paths: sample, count: hiddenCount }
                  )
              : sample
          toast.error(
            result.failed.length === 1
              ? translate(
                  'auto.components.right.sidebar.SourceControl.discardFailed_one',
                  'Failed to discard {{count}} file',
                  { count: result.failed.length }
                )
              : translate(
                  'auto.components.right.sidebar.SourceControl.discardFailed_other',
                  'Failed to discard {{count}} files',
                  { count: result.failed.length }
                ),
            {
              description: firstMsg
                ? translate(
                    'auto.components.right.sidebar.SourceControl.discardFailedWithSample',
                    '{{error}} (e.g. {{paths}})',
                    { error: firstMsg, paths: samplePaths }
                  )
                : samplePaths
            }
          )
        }
        if (!result.aborted) {
          await refreshActiveGitStatusAfterMutation()
          clearSelection()
        }
      } finally {
        setIsExecutingBulk(false)
      }
    },
    [
      activeRepoTarget,
      worktreePath,
      activeWorktreeId,
      grouped,
      isExecutingBulk,
      clearSelection,
      discardMany,
      discardSingle,
      refreshActiveGitStatusAfterMutation,
      setIsExecutingBulk
    ]
  )

  const requestDiscardAllInArea = useCallback(
    (area: DiscardAllArea, confirmedPaths?: readonly string[]): void => {
      if (!worktreePath || !activeWorktreeId || isExecutingBulk) {
        return
      }
      const paths = confirmedPaths ? [...confirmedPaths] : getDiscardAllPaths(grouped[area], area)
      if (paths.length === 0) {
        return
      }
      setPendingDiscard({ kind: 'area', area, paths })
    },
    [activeWorktreeId, grouped, isExecutingBulk, worktreePath]
  )
  const requestDiscardEntry = useCallback(
    (entry: GitStatusEntry): void => {
      if (!worktreePath || !activeWorktreeId || isExecutingBulk) {
        return
      }
      setPendingDiscard({ kind: 'entry', entry })
    },
    [activeWorktreeId, isExecutingBulk, worktreePath]
  )
  const requestDiscardPaths = useCallback(
    (area: DiscardAllArea, paths: readonly string[]): void => {
      // Match execution gates so the dialog cannot confirm an action that silently does nothing.
      if (!worktreePath || !activeWorktreeId || isExecutingBulk || paths.length === 0) {
        return
      }
      setPendingDiscard({ kind: 'area', area, paths: [...paths] })
    },
    [activeWorktreeId, isExecutingBulk, worktreePath]
  )
  const cancelPendingDiscard = useCallback(() => setPendingDiscard(null), [])
  const confirmPendingDiscard = useCallback((): void => {
    const pending = pendingDiscard
    if (!pending) {
      return
    }
    setPendingDiscard(null)
    if (pending.kind === 'entry') {
      void handleDiscard(pending.entry)
      return
    }
    void handleRevertAllInArea(pending.area, pending.paths)
  }, [handleDiscard, handleRevertAllInArea, pendingDiscard])

  return {
    pendingDiscard,
    requestDiscardAllInArea,
    requestDiscardEntry,
    requestDiscardPaths,
    cancelPendingDiscard,
    confirmPendingDiscard
  }
}
