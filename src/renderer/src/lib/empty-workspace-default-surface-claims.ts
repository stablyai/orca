import type { GatedEmptyWorkspaceReseedIntent } from './worktree-initial-terminal-seeding'

// Why: while a gated reseed waits on agent detection, or a chat launch waits on its host's answer,
// that wait owns the workspace's first surface; any other seeder landing in it would put a shell
// beside the chat about to open.
// Why the intent: the detection wait seeds for the latest activation, so a later one must not be
// dropped. A launch's wait replays nothing: its own answer opens the surface.
const pendingIntentByWorkspace = new Map<string, GatedEmptyWorkspaceReseedIntent>()
const launchWaitCountByWorkspace = new Map<string, number>()

/** Holds the first surface for a chat launch until its host answers; the release is idempotent. */
export function holdEmptyWorkspaceDefaultSurfaceForLaunch(workspaceKey: string): () => void {
  launchWaitCountByWorkspace.set(
    workspaceKey,
    (launchWaitCountByWorkspace.get(workspaceKey) ?? 0) + 1
  )
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const remaining = (launchWaitCountByWorkspace.get(workspaceKey) ?? 1) - 1
    if (remaining > 0) {
      launchWaitCountByWorkspace.set(workspaceKey, remaining)
    } else {
      launchWaitCountByWorkspace.delete(workspaceKey)
    }
  }
}

/** Records this activation's intent; false when a wait already pending now carries it instead. */
export function claimEmptyWorkspaceDefaultSurface(
  workspaceKey: string,
  intent: GatedEmptyWorkspaceReseedIntent
): boolean {
  const alreadyPending = pendingIntentByWorkspace.has(workspaceKey)
  pendingIntentByWorkspace.set(workspaceKey, intent)
  return !alreadyPending
}

/** Ends the wait and returns the latest activation's intent. */
export function releaseEmptyWorkspaceDefaultSurface(
  workspaceKey: string
): GatedEmptyWorkspaceReseedIntent | undefined {
  const intent = pendingIntentByWorkspace.get(workspaceKey)
  pendingIntentByWorkspace.delete(workspaceKey)
  return intent
}

export function isEmptyWorkspaceDefaultSurfacePending(workspaceKey: string): boolean {
  return pendingIntentByWorkspace.has(workspaceKey) || launchWaitCountByWorkspace.has(workspaceKey)
}
