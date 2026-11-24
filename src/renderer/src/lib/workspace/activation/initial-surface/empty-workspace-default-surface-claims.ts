import type { GatedEmptyWorkspaceReseedIntent } from './worktree-initial-terminal-seeding'

// Detection/host waits own the first surface so other seeders cannot add a shell beside pending chat. Detection carries the latest activation intent; host launch waits replay nothing.
const pendingIntentByWorkspace = new Map<string, GatedEmptyWorkspaceReseedIntent>()
const launchWaitCountByWorkspace = new Map<string, number>()

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
