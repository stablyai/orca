import React, { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { Worktree } from '../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import { DeleteWorktreeDirtyChangeHint } from '../../sidebar/workspace-actions/deletion/DeleteWorktreeDirtyChangeHint'
import { useDeleteWorktreeStatusHydration } from '../../sidebar/workspace-actions/deletion/use-delete-worktree-status-hydration'
import {
  getDeleteWorktreeChangeCheckStates,
  getDeleteWorktreeDirtyChangeCounts,
  getDeleteWorktreeDirtyChangePreviews
} from '../../sidebar/workspace-actions/deletion/delete-worktree-dirty-change-counts'

const EMPTY: readonly Worktree[] = []

function statusKey(worktree: Worktree): string {
  return worktree.hostId ? getWorktreeHostIdentity(worktree) : worktree.id
}

/**
 * Remove Project keeps files on disk, but the user loses sight of its conversations; list the ones
 * with uncommitted work, each with its files and diffs, before they confirm.
 */
export function ZotzProjectRemovalChanges({
  repoId,
  hostId,
  isOpen
}: {
  repoId: string
  hostId: ExecutionHostId | null
  isOpen: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const repos = useAppStore((s) => s.repos)
  const repoWorktrees = useAppStore((s) => selectWorktreesByRepo(s)[repoId] ?? EMPTY)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const deleteStateByWorktreeId = useAppStore((s) => s.deleteStateByWorktreeId)
  const repoMap = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const targets = useMemo(
    () =>
      repoWorktrees.filter(
        (worktree) =>
          !worktree.isMainWorktree && (!hostId || (worktree.hostId ?? 'local') === hostId)
      ),
    [hostId, repoWorktrees]
  )
  const gitStatusByWorktreeIdentity = useDeleteWorktreeStatusHydration({
    isOpen,
    deleteTargets: targets,
    visibleTargets: targets,
    repoMap
  })
  const status = useMemo(() => {
    const input = {
      deleteTargets: targets,
      gitStatusByWorktree,
      gitStatusByWorktreeIdentity,
      repoMap
    }
    return {
      checkStates: getDeleteWorktreeChangeCheckStates(input),
      counts: getDeleteWorktreeDirtyChangeCounts({ ...input, deleteStateByWorktreeId }),
      previews: getDeleteWorktreeDirtyChangePreviews(input)
    }
  }, [deleteStateByWorktreeId, gitStatusByWorktree, gitStatusByWorktreeIdentity, repoMap, targets])

  const withChanges = targets.filter(
    (worktree) => (status.counts.get(statusKey(worktree)) ?? 0) > 0
  )
  const checking = targets.some(
    (worktree) => status.checkStates.get(statusKey(worktree)) === 'checking'
  )
  if (withChanges.length === 0) {
    return checking ? (
      <p className="text-xs text-muted-foreground">
        {t('zotz.removeProject.checking', 'Checking conversations for uncommitted changes…')}
      </p>
    ) : null
  }
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
      <p className="font-medium text-destructive">
        {t('zotz.removeProject.uncommitted', '{{count}} conversations have uncommitted changes', {
          count: withChanges.length,
          defaultValue_one: '{{count}} conversation has uncommitted changes'
        })}
      </p>
      <p className="mt-0.5 text-muted-foreground">
        {t(
          'zotz.removeProject.uncommittedDetail',
          'They stay on disk, but this project and its conversations leave Zotz. Open a list to review each change.'
        )}
      </p>
      <ul className="mt-2 space-y-1.5">
        {withChanges.map((worktree) => (
          <li key={statusKey(worktree)} className="min-w-0">
            <div className="truncate font-medium text-foreground">{worktree.displayName}</div>
            <DeleteWorktreeDirtyChangeHint
              owner={worktree}
              keptLabel={t('zotz.removeProject.changesKept', '{{count}} uncommitted changes', {
                count: status.counts.get(statusKey(worktree)) ?? 0,
                defaultValue_one: '{{count}} uncommitted change'
              })}
              checkState={status.checkStates.get(statusKey(worktree))}
              changeCount={status.counts.get(statusKey(worktree))}
              preview={status.previews.get(statusKey(worktree))}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
