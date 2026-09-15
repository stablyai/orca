import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  resolveWorkspaceTerminalHostAuthority,
  type WorkspaceTerminalHostAuthorityState
} from './workspace-terminal-host-authority'

export type WorkspaceExecutionEvidence = 'live' | 'unverifiable' | 'exited'

// One sentence per verdict, so every reader that refused to write reports the same vocabulary.
// `live` is positive host ownership and must never be reported as an unverifiable host.
export function describeWorkspaceExecutionEvidence(evidence: WorkspaceExecutionEvidence): string {
  if (evidence === 'live') {
    return 'The execution host owns this workspace surface. Wait for it to publish or reconnect.'
  }
  if (evidence === 'unverifiable') {
    return 'Orca cannot verify the execution host. Reconnect before retrying recovery.'
  }
  return 'No concrete surface producer owns this empty workspace activation.'
}

export function resolveWorkspaceExecutionEvidence(
  state: WorkspaceTerminalHostAuthorityState,
  workspaceKey: string,
  executionHostId: ExecutionHostId,
  hostAbsenceConfirmed = false
): WorkspaceExecutionEvidence {
  const authority = resolveWorkspaceTerminalHostAuthority(state, workspaceKey)
  if (authority !== 'none') {
    return authority
  }
  const host = parseExecutionHostId(executionHostId)
  if (!host || host.kind === 'local') {
    return 'exited'
  }
  if (host.kind === 'runtime') {
    return 'unverifiable'
  }
  if (parseWorkspaceKey(workspaceKey)?.type === 'folder') {
    // SSH snapshots replace git-worktree rows only; a folder needs its own host-scoped census.
    return hostAbsenceConfirmed ? 'exited' : 'unverifiable'
  }
  const syncStatus = state.remoteWorkspaceSyncStatusByTargetId?.[host.targetId]
  return state.remoteWorkspaceHydratedTargetIds?.has(host.targetId) &&
    syncStatus?.phase === 'synced'
    ? 'exited'
    : 'unverifiable'
}
