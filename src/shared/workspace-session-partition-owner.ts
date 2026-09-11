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

/**
 * Release N of the SSH partition move: where the CLIENT writes a worktree's session.
 *
 * `workspaceSessionPartitionHostId` above is the destination this is converging on, and the READ
 * side already uses it — boot hydration enumerates `ssh:<targetId>` and
 * `adoptStrandedHostPartitionSession` reunites it with `local`. Moving the WRITE in the same
 * release is the part a downgrade cannot survive. Every shipped build reads SSH session state out
 * of `local` alone, so a client that has moved it looks empty to the previous version, and that
 * version's publish then OMITS the workspace — which the relay applies as a wholesale
 * `replace-session` snapshot overwrite (src/relay/workspace-session-handler.ts), so the host
 * forgets it too.
 *
 * Exposure is launch-and-quit, not "use an SSH workspace": routing reads the persisted repo
 * catalog, so an offline target with no multiplexer still moves on the quit checkpoint.
 *
 * Shipping the read alone is not a half-fix. Reading both partitions IS the repair for #12721 —
 * the merge can only refuse to delete tabs this client actually holds, and hydrating them is what
 * arms that defence. Moving the write collapses the #12723 double-ownership, which is cleanup.
 *
 * N+1 deletes this function and its two call sites; see docs/reference/ssh-session-partition-move.md.
 */
export function clientWorkspaceSessionWritePartitionHostId(
  executionHostId: string | null | undefined
): ExecutionHostId {
  const partition = workspaceSessionPartitionHostId(executionHostId)
  return parseExecutionHostId(partition)?.kind === 'ssh' ? LOCAL_EXECUTION_HOST_ID : partition
}
