import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { acceptReplayedWebSessionTabsSnapshot } from './state'

export {
  mirroredTerminalHandle,
  onMirroredTerminalHandlesChanged
} from './mirrored-terminal-handle-index'

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

export function isFrameDrawnServerWorkspace(environmentId: string, worktreeId: string): boolean {
  return frameDrawnWorktreeIdsByEnvironment.get(environmentId)?.has(worktreeId) ?? false
}

/** Switch point: a desktop write to a frame-drawn workspace keeps none of the mirror's ledgers. */
export function isServerFrameDrawnWorkspace(environmentId: string, worktreeId: string): boolean {
  return ORCA_LAYOUT_OWNER_IS_MAIN && isFrameDrawnServerWorkspace(environmentId, worktreeId)
}

/** Hands a workspace back: a fresh full snapshot replaces what frames drew. Rejects when the fetch fails. */
export async function resyncMirroredServerWorkspace(
  environmentId: string,
  worktreeId: string
): Promise<void> {
  const current = frameDrawnWorktreeIdsByEnvironment.get(environmentId)
  if (current?.has(worktreeId)) {
    setFrameDrawnServerWorkspaces(
      environmentId,
      new Set([...current].filter((id) => id !== worktreeId))
    )
  }
  // Why lazy: keeps the RPC layer out of the apply's import graph, as the tab lifecycle module does.
  const { refreshWebRuntimeSessionTabsSnapshot } = await import('../web-runtime-session-snapshot')
  // Why replay: frames-era frames already advanced freshness, so the current version would read as stale.
  acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
  await refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId, { errorMode: 'throw' })
}

export function resetFrameDrawnServerWorkspacesForTests(): void {
  frameDrawnWorktreeIdsByEnvironment.clear()
}
