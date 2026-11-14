/** Git worktrees per repo id, in listing order. */
export function selectWorktreesByRepo<TState extends { worktreesByRepo?: unknown }>(
  state: TState
): TState['worktreesByRepo'] {
  return state.worktreesByRepo
}

export function selectFolderWorkspaces<TState extends { folderWorkspaces?: unknown }>(
  state: TState
): TState['folderWorkspaces'] {
  return state.folderWorkspaces
}

/** Checkouts git reports that Orca does not track, per repo id. */
export function selectDetectedWorktreesByRepo<TState extends { detectedWorktreesByRepo?: unknown }>(
  state: TState
): TState['detectedWorktreesByRepo'] {
  return state.detectedWorktreesByRepo
}
