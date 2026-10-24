import { acceptReplayedWebSessionTabsSnapshot } from './state'
import {
  frameDrawnServerWorkspaceIds,
  setFrameDrawnServerWorkspaces
} from './frame-drawn-server-workspace-set'

export {
  isFrameDrawnServerWorkspace,
  isServerFrameDrawnWorkspace,
  resetFrameDrawnServerWorkspacesForTests,
  setFrameDrawnServerWorkspaces
} from './frame-drawn-server-workspace-set'

export {
  mirroredTerminalHandle,
  onMirroredTerminalHandlesChanged
} from './mirrored-terminal-handle-index'

/** Hands a workspace back: a fresh full snapshot replaces what frames drew. Rejects when the fetch fails. */
export async function resyncMirroredServerWorkspace(
  environmentId: string,
  worktreeId: string
): Promise<void> {
  const current = frameDrawnServerWorkspaceIds(environmentId)
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
