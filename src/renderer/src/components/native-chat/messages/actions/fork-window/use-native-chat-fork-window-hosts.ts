import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getResourceExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../../shared/worktree/types'
import type { NativeChatForkHostInput } from './native-chat-fork-window-choices'

/** This computer and every paired host, with what each advertises while it is connected. */
export function useNativeChatForkHosts(): NativeChatForkHostInput[] {
  const t = useTranslate()
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const statuses = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const local = useSyncExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilitiesOrUnknown
  )
  useEffect(() => {
    void ensureLocalRuntimeCapabilities()
  }, [])
  return useMemo(() => {
    const remote = environments.map((environment): NativeChatForkHostInput => {
      const entry = statuses.get(environment.id)
      const status = isRuntimeHostContactRevoked(entry) ? null : lastVerifiedRuntimeStatus(entry)
      return {
        id: toRuntimeExecutionHostId(environment.id),
        label: environment.name,
        capabilities: status ? (status.capabilities ?? []) : null
      }
    })
    return [
      {
        id: LOCAL_EXECUTION_HOST_ID,
        label: t('components.native-chat.fork.window.thisComputer', 'This computer'),
        capabilities: local ?? []
      },
      ...remote
    ]
  }, [environments, local, statuses, t])
}

/** The worktrees whose owner is `hostId`, by name, leaving out the chat's own. */
function worktreesOnHost(
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>,
  repos: readonly { id: string }[],
  hostId: ExecutionHostId,
  sourceWorktreeId: string
): Worktree[] {
  const state = useAppStore.getState()
  return Object.values(worktreesByRepo)
    .flat()
    .filter(
      (worktree) =>
        worktree.id !== sourceWorktreeId &&
        repos.some((repo) => repo.id === worktree.repoId) &&
        getResourceExecutionHostIdForWorktree(state, worktree.id) === hostId
    )
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
}

/** The worktrees that run on `hostId`, by name, leaving out the chat's own. */
export function useNativeChatForkHostWorktrees(
  hostId: ExecutionHostId,
  sourceWorktreeId: string
): Worktree[] {
  const worktreesByRepo = useAppStore(selectWorktreesByRepo)
  const repos = useAppStore((state) => state.repos)
  return useMemo(
    () => worktreesOnHost(worktreesByRepo, repos, hostId, sourceWorktreeId),
    [hostId, repos, sourceWorktreeId, worktreesByRepo]
  )
}
