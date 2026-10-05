import type { GatedEmptyWorkspaceReseedIntent } from './worktree-initial-terminal-seeding'

// Why: while a gated reseed waits on agent detection, it owns the workspace's first surface;
// any other seeder landing in that wait would put a shell beside the chat it is about to open.
// Why the intent: the wait seeds for the latest activation, so a later one must not be dropped.
const pendingIntentByWorkspace = new Map<string, GatedEmptyWorkspaceReseedIntent>()

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
  return pendingIntentByWorkspace.has(workspaceKey)
}
