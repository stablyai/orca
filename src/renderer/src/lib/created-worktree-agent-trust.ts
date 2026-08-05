import type { AppState } from '@/store/types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { findRepoForWorktreeOwner } from '@/store/slices/repo-host-identity'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent, Worktree } from '../../../shared/types'

type CreatedWorktreeTrustTarget = Pick<
  Worktree,
  'id' | 'repoId' | 'path' | 'hostId' | 'runtimeOwnerEnvironmentId'
>

export async function preflightCreatedWorktreeAgentTrust(
  state: AppState,
  agent: TuiAgent | null,
  worktree: CreatedWorktreeTrustTarget
): Promise<void> {
  if (!agent || !worktree.path) {
    return
  }
  const preset = TUI_AGENT_CONFIG[agent].preflightTrust
  if (!preset) {
    return
  }
  const ownerRepo = findRepoForWorktreeOwner(state.repos, worktree)
  const owner = resolveExactWorktreeRoute(state, {
    id: worktree.id,
    repoId: worktree.repoId,
    hostId: worktree.hostId ?? (ownerRepo ? getRepoExecutionHostId(ownerRepo) : undefined),
    runtimeOwnerEnvironmentId: worktree.runtimeOwnerEnvironmentId
  })
  if (owner.kind !== 'resolved') {
    return
  }

  try {
    if (owner.route.runtimeEnvironmentId) {
      await callRuntimeRpc(
        { kind: 'environment', environmentId: owner.route.runtimeEnvironmentId },
        'preflight.markAgentTrusted',
        { agent, workspacePath: worktree.path }
      )
      return
    }
    if (!window.api.agentTrust?.markTrusted) {
      return
    }
    const host = parseExecutionHostId(owner.route.executionHostId)
    await window.api.agentTrust.markTrusted({
      preset,
      workspacePath: worktree.path,
      ...(host?.kind === 'ssh' ? { connectionId: host.targetId } : {})
    })
  } catch {
    // Best-effort: the created workspace must remain usable when trust setup fails.
  }
}
