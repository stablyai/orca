export type PruneClosedOpenFileArgs = {
  worktreeId: string
  filePath: string
}

type PartitionSessionApi = {
  /** Main-side atomic prune across partitions; see the session:prune-closed-open-file handler. */
  pruneClosedOpenFile: (args: PruneClosedOpenFileArgs) => Promise<void>
}

/**
 * A closed editor file must not survive in host partitions the workspace no longer runs on: a
 * superseded partition's stale `openFilesByWorktree` row (with any `dirtyDraftContent`) re-
 * materializes the tab at the next hydration, so a "Don't Save" close that only clears the
 * current partition's state loses to the residue (#42761). The read-and-remove runs entirely in
 * main so concurrent closes cannot interleave reads and writes.
 */
export async function pruneClosedOpenFileFromAllPartitions(
  api: PartitionSessionApi,
  args: PruneClosedOpenFileArgs
): Promise<void> {
  try {
    await api.pruneClosedOpenFile(args)
  } catch (err) {
    // A stale partition, an older main without the handler, or a test stub must never break the
    // close; the owning partition's write still drops its row.
    console.warn('[session] pruning the closed file across partitions failed:', err)
  }
}
