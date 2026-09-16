import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { GitStatusResult } from '../../../../shared/git-status-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { isFolderWorkspaceDelete } from './delete-worktree-dialog-copy'
import { orderDeleteWorktreeStatusHydrationTargets } from './delete-worktree-dirty-change-counts'

const EMPTY_STATUS_BY_IDENTITY = new Map<string, GitStatusResult['entries']>()

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
}): ReadonlyMap<string, GitStatusResult['entries']> {
  const repos = useAppStore((state) => state.repos)
  const settings = useAppStore((state) => state.settings)
  const generation = isOpen ? deleteTargets.map(getWorktreeHostIdentity).join('\n') : ''
  const generationRef = useRef(generation)
  const [statusByIdentity, setStatusByIdentity] = useState<Map<string, GitStatusResult['entries']>>(
    () => new Map()
  )
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
      const owner = target.hostId
        ? findRepoForHost(repos, target.repoId, { hostId: target.hostId })
        : undefined
      const parsedHost = parseExecutionHostId(target.hostId)
      const runtimeEnvironmentId = parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null
      const runtimeSettings = target.hostId
        ? settings
          ? { ...settings, activeRuntimeEnvironmentId: runtimeEnvironmentId }
          : { activeRuntimeEnvironmentId: runtimeEnvironmentId }
        : getSettingsForWorktreeRuntimeOwner(
            { repos, settings, worktreesByRepo: useAppStore.getState().worktreesByRepo },
            target.id
          )
      void getRuntimeGitStatus(
        {
          settings: runtimeSettings,
          worktreeId: target.id,
          worktreePath: target.path,
          connectionId: target.hostId
            ? (owner?.connectionId ?? undefined)
            : (getConnectionId(target.id) ?? undefined)
        },
        { admissionTier: 'background', includeLineStats: false, signal: controller.signal }
      )
        .then((status) => {
          if (!controller.signal.aborted && generationRef.current === generation) {
            setStatusByIdentity((current) => new Map(current).set(identity, status.entries))
          }
        })
        .catch(() => {
          // Best effort only; deletion performs the authoritative backend check.
        })
    }
    return () => {
      controller.abort()
    }
  }, [deleteTargets, generation, isOpen, repoMap, repos, settings, visibleTargets])

  return currentStatusByIdentity
}
