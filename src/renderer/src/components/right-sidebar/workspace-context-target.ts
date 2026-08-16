import type { SkillDiscoveryTarget } from '../../../../shared/skills'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getExecutionHostIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import type { NativeChatSkillStateInputs } from '@/components/native-chat/native-chat-skill-discovery-context'

export type WorkspaceContextTarget = {
  key: string
  cwd: string
  executionHostKind: 'local' | 'runtime' | 'ssh'
  runtimeTarget: RuntimeClientTarget
  discoveryTarget: SkillDiscoveryTarget
}

function resolveWorkspaceCwd(state: NativeChatSkillStateInputs, worktreeId: string): string | null {
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    const worktree = worktrees.find((entry) => entry.id === worktreeId)
    if (worktree) {
      return worktree.path
    }
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return (
      state.folderWorkspaces.find((workspace) => workspace.id === workspaceScope.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  return null
}

/**
 * Which host runs this workspace's agents, and therefore where its context is
 * read — the same rule native chat applies to skill discovery, minus the pane:
 * SSH workspaces are inspected nowhere (the client cannot read that disk), an
 * environment-owned workspace resolves on its runtime, everything else here.
 */
export function resolveWorkspaceContextTarget(
  state: NativeChatSkillStateInputs,
  worktreeId: string | null
): WorkspaceContextTarget | null {
  if (!worktreeId) {
    return null
  }
  const cwd = resolveWorkspaceCwd(state, worktreeId)
  if (!cwd) {
    return null
  }
  const hostId = getExecutionHostIdForWorktree(state, worktreeId)
  const parsedHost = parseExecutionHostId(hostId)
  if (parsedHost?.kind === 'ssh') {
    return {
      key: JSON.stringify(['ssh', hostId, cwd]),
      cwd,
      executionHostKind: 'ssh',
      runtimeTarget: { kind: 'local' },
      discoveryTarget: { cwd, worktreeId }
    }
  }
  const runtimeEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (parsedHost?.kind === 'runtime' && !runtimeEnvironmentId) {
    return null
  }
  const runtimeTarget: RuntimeClientTarget = runtimeEnvironmentId
    ? { kind: 'environment', environmentId: runtimeEnvironmentId }
    : { kind: 'local' }
  const projectRuntime = runtimeEnvironmentId
    ? undefined
    : getLocalProjectExecutionRuntimeContext(state, worktreeId)
  const projectRuntimeKey =
    projectRuntime?.status === 'resolved'
      ? projectRuntime.runtime.cacheKey
      : projectRuntime?.repair.cacheKey
  return {
    key: JSON.stringify([
      runtimeTarget.kind,
      runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null,
      hostId,
      projectRuntimeKey ?? null,
      cwd
    ]),
    cwd,
    executionHostKind: runtimeEnvironmentId ? 'runtime' : 'local',
    runtimeTarget,
    discoveryTarget: { cwd, worktreeId, ...(projectRuntime ? { projectRuntime } : {}) }
  }
}
