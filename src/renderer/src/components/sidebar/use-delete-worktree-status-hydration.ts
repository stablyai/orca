import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { resolveWorktreeGitStatusTarget } from '@/lib/worktree-git-status-target'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { GitStatusResult } from '../../../../shared/git-status-types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { isFolderWorkspaceDelete } from './delete-worktree-dialog-copy'
import { orderDeleteWorktreeStatusHydrationTargets } from './delete-worktree-dirty-change-counts'

const EMPTY_STATUS_BY_IDENTITY = new Map<string, GitStatusResult['entries'] | null>()

export function useDeleteWorktreeStatusHydration({
  isOpen,
  deleteTargets,
  visibleTargets,
  repoMap
}: {
  isOpen: boolean
  deleteTargets: readonly Worktree[]
  visibleTargets: readonly Worktree[]
  repoMap: ReadonlyMap<string, Repo>
}): ReadonlyMap<string, GitStatusResult['entries'] | null> {
  const repos = useAppStore((state) => state.repos)
  const generation = isOpen ? deleteTargets.map(getWorktreeHostIdentity).join('\n') : ''
  const generationRef = useRef(generation)
  const [statusByIdentity, setStatusByIdentity] = useState<
    Map<string, GitStatusResult['entries'] | null>
  >(() => new Map())
  const currentStatusByIdentity =
    generationRef.current === generation ? statusByIdentity : EMPTY_STATUS_BY_IDENTITY

  useEffect(() => {
    generationRef.current = generation
    setStatusByIdentity(new Map())
    if (!isOpen) {
      return
    }
    const gitStatusByWorktree = useAppStore.getState().gitStatusByWorktree
    const currentState = useAppStore.getState()
    const targets = orderDeleteWorktreeStatusHydrationTargets({
      targets: deleteTargets.filter(
        (target) => !target.isMainWorktree && !isFolderWorkspaceDelete(repoMap, target)
      ),
      visibleTargets,
      activeWorktreeId: currentState.activeWorktreeId,
      activeExecutionHostId: currentState.activeWorkspaceExecutionHostId
    })
    const controller = new AbortController()
    for (const target of targets) {
      const identity = getWorktreeHostIdentity(target)
      const existingStatus = target.hostId ? undefined : gitStatusByWorktree[target.id]
      if (existingStatus) {
        setStatusByIdentity((current) => new Map(current).set(identity, existingStatus))
        continue
      }
      const statusTarget = resolveWorktreeGitStatusTarget({ ...currentState, repos }, target)
      if (!statusTarget) {
        setStatusByIdentity((current) => new Map(current).set(identity, null))
        continue
      }
      void getRuntimeGitStatus(
        {
          target: statusTarget.target,
          worktreeId: target.id,
          worktreePath: target.path,
          connectionId: statusTarget.connectionId
        },
        { admissionTier: 'background', includeLineStats: false, signal: controller.signal }
      )
        .then((status) => {
          if (!controller.signal.aborted && generationRef.current === generation) {
            setStatusByIdentity((current) => new Map(current).set(identity, status.entries))
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && generationRef.current === generation) {
            setStatusByIdentity((current) => new Map(current).set(identity, null))
          }
        })
    }
    return () => {
      controller.abort()
    }
  }, [deleteTargets, generation, isOpen, repoMap, repos, visibleTargets])

  return currentStatusByIdentity
}
