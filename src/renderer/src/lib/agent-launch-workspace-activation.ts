/**
 * The workspace a desktop `agent.launch` create opened, by that launch's operation id.
 *
 * The host names the launch on the activation it already sends when the create opens the
 * workspace, before the launch answers (which waits on prompt delivery). The launch this window is
 * running takes that activation over: it decides whether to show the workspace (the user may have
 * moved on) and lays out its own first tab. With no such launch here (a reloaded window, another
 * window's launch), the window opens the workspace as for any activation. The launch's answer
 * carries the same `worktreeId`, so a launch that missed this still learns it.
 */

type ActivationOwner = (worktreeId: string) => void

const owners = new Map<string, ActivationOwner>()

export function ownAgentLaunchWorkspaceActivation(
  operationId: string,
  owner: ActivationOwner
): () => void {
  owners.set(operationId, owner)
  return () => {
    if (owners.get(operationId) === owner) {
      owners.delete(operationId)
    }
  }
}

/** True when a launch running in this window took the activation over. */
export function takeAgentLaunchWorkspaceActivation(
  operationId: string,
  worktreeId: string
): boolean {
  const owner = owners.get(operationId)
  if (!owner) {
    return false
  }
  owner(worktreeId)
  return true
}
