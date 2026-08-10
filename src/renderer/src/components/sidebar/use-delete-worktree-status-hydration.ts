import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import type { Repo, Worktree } from '../../../../shared/types'
import { isFolderWorkspaceDelete } from './delete-worktree-dialog-copy'

export function useDeleteWorktreeStatusHydration({
  isOpen,
  deleteTargets,
  repoMap
}: {
  isOpen: boolean
  deleteTargets: readonly Worktree[]
  repoMap: ReadonlyMap<string, Repo>
}): void {
  const repos = useAppStore((state) => state.repos)
  const settings = useAppStore((state) => state.settings)
  const setGitStatus = useAppStore((state) => state.setGitStatus)

  useEffect(() => {
    if (!isOpen) {
      return
    }
    const gitStatusByWorktree = useAppStore.getState().gitStatusByWorktree
    const targets = deleteTargets.filter(
      (target) =>
        !target.isMainWorktree &&
        !isFolderWorkspaceDelete(repoMap, target) &&
        gitStatusByWorktree[target.id] === undefined
    )
    const controller = new AbortController()
    for (const target of targets) {
      void getRuntimeGitStatus(
        {
          settings: getSettingsForWorktreeRuntimeOwner(
            { repos, settings, worktreesByRepo: useAppStore.getState().worktreesByRepo },
            target.id
          ),
          worktreeId: target.id,
          worktreePath: target.path,
          connectionId: getConnectionId(target.id) ?? undefined
        },
        { signal: controller.signal }
      )
        .then((status) => {
          if (!controller.signal.aborted) {
            setGitStatus(target.id, status)
          }
        })
        .catch(() => {
          // Best effort only; deletion performs the authoritative backend check.
        })
    }
    return () => {
      controller.abort()
    }
  }, [deleteTargets, isOpen, repoMap, repos, setGitStatus, settings])
}
