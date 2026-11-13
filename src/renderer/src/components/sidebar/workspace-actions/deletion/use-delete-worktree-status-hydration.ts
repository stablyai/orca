import { useEffect, useEffectEvent, useState } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
import { runtimeTargetForWorkspaceOwner } from '@/lib/workspace/ownership/resolve-owner'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { getRuntimeGitStatus } from '@/runtime/source-control/git/runtime-git-status-client'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import { findRepoForHost } from '@/store/repos/repo-host-identity'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { GitStatusResult } from '../../../../../../shared/git/status/git-status-types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { isFolderWorkspaceDelete } from './delete-worktree-dialog-copy'
import { orderDeleteWorktreeStatusHydrationTargets } from './delete-worktree-dirty-change-counts'

/** Routes a delete target's git reads to its owning host; null when no host can serve it. */
export function resolveDeleteTargetGitContext(
  target: Worktree,
  repos: readonly Repo[]
): RuntimeGitContext | null {
  const owner = target.hostId
    ? findRepoForHost(repos, target.repoId, { hostId: target.hostId })
    : undefined
  const ownerTarget = target.hostId
    ? ipcOrRuntimeTargetForHostId(target.hostId)
    : runtimeTargetForWorkspaceOwner(useAppStore.getState(), { workspaceId: target.id })
  if (!ownerTarget) {
    return null
  }
  return {
    target: ownerTarget,
    worktreeId: target.id,
    worktreePath: target.path,
    connectionId: target.hostId
      ? (owner?.connectionId ?? undefined)
      : (getConnectionId(target.id) ?? undefined)
  }
}

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
  const generation = isOpen
    ? deleteTargets
        .map((target) =>
          JSON.stringify({
            identity: getWorktreeHostIdentity(target),
            isMainWorktree: target.isMainWorktree,
            isFolderWorkspace: isFolderWorkspaceDelete(repoMap, target),
            context: resolveDeleteTargetGitContext(target, repos)
          })
        )
        .sort()
        .join('\n')
    : ''
  const [result, setResult] = useState<{
    generation: string
    statuses: Map<string, GitStatusResult['entries'] | null>
  }>({ generation: '', statuses: new Map() })
  const startChecks = useEffectEvent((signal: AbortSignal) => {
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
    for (const target of targets) {
      const identity = getWorktreeHostIdentity(target)
      const publish = (entries: GitStatusResult['entries'] | null): void =>
        setResult((current) => ({
          generation,
          statuses: new Map(current.generation === generation ? current.statuses : []).set(
            identity,
            entries
          )
        }))
      const existingStatus = target.hostId ? undefined : gitStatusByWorktree[target.id]
      if (existingStatus) {
        publish(existingStatus)
        continue
      }
      const gitContext = resolveDeleteTargetGitContext(target, repos)
      if (!gitContext) {
        publish(null)
        continue
      }
      void getRuntimeGitStatus(gitContext, {
        admissionTier: 'background',
        includeLineStats: false,
        signal
      })
        .then((status) => {
          if (!signal.aborted) {
            publish(status.entries)
          }
        })
        .catch(() => {
          if (!signal.aborted) {
            publish(null)
          }
        })
    }
  })

  // Catalog refreshes replace arrays; restart only when targets or their read routes change.
  useEffect(() => {
    setResult({ generation, statuses: new Map() })
    if (!isOpen) {
      return
    }
    const controller = new AbortController()
    startChecks(controller.signal)
    return () => {
      controller.abort()
    }
  }, [generation, isOpen])

  return result.generation === generation ? result.statuses : EMPTY_STATUS_BY_IDENTITY
}
