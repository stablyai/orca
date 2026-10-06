import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from './execution-host'

/**
 * The one partition a worktree's durable session state lives in: its own execution host.
 *
 * This used to answer differently depending on who asked (stablyai/orca#12723). The renderer
 * mapped SSH worktrees to the `local` blob while the main-process runtime read-modify-wrote
 * `ssh:<targetId>`, so one workspace's session was split across two stores and neither reader
 * reunited them. Whatever landed on the unread side did not read as unknown — it round-tripped as
 * absence, and the replace-session upload converted that into deletion (#12721, #18173).
 *
 * There is no second model now: `runtime:*` and `ssh:*` each own their partition, `local` owns the
 * legacy `workspaceSession` blob. Rows a shipping build left in `local` for an SSH worktree are
 * still real, so the read side folds them back in — see `adoptStrandedHostPartitionSession` — and
 * the next write returns the unified result to the owning partition.
 */
export function workspaceSessionPartitionHostId(
  executionHostId: string | null | undefined
): ExecutionHostId {
  return parseExecutionHostId(executionHostId)?.id ?? LOCAL_EXECUTION_HOST_ID
}
