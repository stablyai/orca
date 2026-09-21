import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from './execution-host'

/**
 * Where an SSH-owned worktree's durable session state lives.
 *
 * This is the single axis on which the renderer and the main-process runtime disagree today
 * (stablyai/orca#12723). Both sides now compute their partition through this function so the
 * divergence is one argument in one place instead of two independently drifting owner maps:
 *
 * - `local-partition` — the renderer's shipping model. SSH worktrees keep their session state in
 *   the `local` partition; partitioning them would double-own the data.
 * - `host-partition` — the runtime's shipping model (#12671). Pane retirement, windowless PTY
 *   handoff and orchestration fences read-modify-write `ssh:<targetId>`.
 *
 * Both partitions hold real data written by shipping builds, so neither side can simply adopt the
 * other's answer: flipping a resolver orphans whichever store it stops reading. Converging needs a
 * read-both transition (generalize `workspaceSessionPartitionIdsForHost`) and should converge on
 * `host-partition`, since Orca Remote — SSH's successor — is already partitioned as `runtime:*`.
 * Until then this function preserves today's behaviour exactly on both sides.
 */
export type WorkspaceSessionSshOwnership = 'local-partition' | 'host-partition'

export function workspaceSessionPartitionHostId(
  executionHostId: string | null | undefined,
  sshOwnership: WorkspaceSessionSshOwnership
): ExecutionHostId {
  const parsed = parseExecutionHostId(executionHostId)
  if (parsed?.kind === 'runtime') {
    return parsed.id
  }
  if (parsed?.kind === 'ssh') {
    return sshOwnership === 'host-partition' ? parsed.id : LOCAL_EXECUTION_HOST_ID
  }
  return LOCAL_EXECUTION_HOST_ID
}
