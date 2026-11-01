import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { authorityKey, SELF_LOCAL_AUTHORITY } from '../../../../shared/host-authority'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { WorkspaceSleepHost, WorkspaceSleepTarget } from '../../../../shared/workspace-sleep'
import { resolveOwner } from '@/lib/resolve-owner'
import { resolveTerminalPtyOwner } from '@/lib/terminal-worktree-route'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import { workspacePublishingHosts } from '@/store/slices/worktrees/teardown/host-twin-worktree-purge'
import { resolveTerminalTeardownOwner } from '@/store/terminals/terminal-teardown-owner'
import type { AppState } from '@/store/types'

/** One runtime per copy of the workspace; with no listing row, the workspace's route. */
function chatHostTargets(
  state: AppState,
  workspaceId: string
): Map<ExecutionHostId, RuntimeClientTarget> {
  const hosts = workspacePublishingHosts(state, workspaceId)
  const targets = new Map<ExecutionHostId, RuntimeClientTarget>()
  for (const hostId of hosts.length > 0 ? hosts : [undefined]) {
    const match = resolveOwner(state, hostId ? { workspaceId, hostId } : { workspaceId })
    const owner =
      match.kind === 'resolved'
        ? match.owner
        : match.kind === 'missing'
          ? SELF_LOCAL_AUTHORITY
          : null
    // Why null for a directly dialed SSH place: no native chat host runs there.
    const target = owner ? runtimeRpcTargetForAuthorityKey(authorityKey(owner)) : null
    if (target) {
      const key =
        target.kind === 'local'
          ? LOCAL_EXECUTION_HOST_ID
          : toRuntimeExecutionHostId(target.environmentId)
      targets.set(key, target)
    }
  }
  return targets
}

function sleepHostOf(target: RuntimeClientTarget): WorkspaceSleepHost {
  return target.kind === 'local'
    ? { kind: 'self' }
    : { kind: 'environment', environmentId: target.environmentId }
}

/** Resolve the terminal host and every chat host; refuse sleep if terminal ownership is unknown. */
export function workspaceSleepTarget(
  state: AppState,
  worktreeId: string
): WorkspaceSleepTarget | { refused: string } {
  const ptyIds = (state.tabsByWorktree[worktreeId] ?? []).flatMap(
    (tab) => state.ptyIdsByTabId[tab.id] ?? []
  )
  const owner = resolveTerminalTeardownOwner(resolveTerminalPtyOwner(state, worktreeId), ptyIds)
  if (owner.kind === 'refused') {
    return { refused: owner.reason }
  }
  return {
    worktreeId,
    terminalHost: owner.runtimeEnvironmentId
      ? { kind: 'environment', environmentId: owner.runtimeEnvironmentId }
      : { kind: 'self' },
    chatHosts: [...chatHostTargets(state, worktreeId).values()].map(sleepHostOf)
  }
}
