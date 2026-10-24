// Which server workspaces layout frames draw: a leaf, so store slices can ask without the sync graph.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

// Why one source per workspace: frames and the mirror writing the same tree would fight.
const frameDrawnWorktreeIdsByEnvironment = new Map<string, ReadonlySet<string>>()

/**
 * The workspaces of `environmentId` that a server's layout frames draw; replaces the previous set.
 * A workspace leaving the set keeps its frame tree until `resyncMirroredServerWorkspace` replaces it.
 */
export function setFrameDrawnServerWorkspaces(
  environmentId: string,
  worktreeIds: ReadonlySet<string>
): void {
  if (worktreeIds.size === 0) {
    frameDrawnWorktreeIdsByEnvironment.delete(environmentId)
    return
  }
  frameDrawnWorktreeIdsByEnvironment.set(environmentId, new Set(worktreeIds))
}

export function frameDrawnServerWorkspaceIds(
  environmentId: string
): ReadonlySet<string> | undefined {
  return frameDrawnWorktreeIdsByEnvironment.get(environmentId)
}

export function isFrameDrawnServerWorkspace(environmentId: string, worktreeId: string): boolean {
  return frameDrawnWorktreeIdsByEnvironment.get(environmentId)?.has(worktreeId) ?? false
}

/** Switch point: a desktop write to a frame-drawn workspace keeps none of the mirror's ledgers. */
export function isServerFrameDrawnWorkspace(environmentId: string, worktreeId: string): boolean {
  return ORCA_LAYOUT_OWNER_IS_MAIN && isFrameDrawnServerWorkspace(environmentId, worktreeId)
}

export function resetFrameDrawnServerWorkspacesForTests(): void {
  frameDrawnWorktreeIdsByEnvironment.clear()
}
