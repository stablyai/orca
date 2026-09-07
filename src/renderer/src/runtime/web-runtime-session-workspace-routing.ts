import type { ExecutionHostId } from '../../../shared/execution-host'

/**
 * Which runtime environment a web-runtime-session call targets.
 *
 * `undefined` means the caller never resolved ownership, so the focused
 * environment is the only candidate it can have meant. An explicit `null` (or a
 * blank string) is the opposite claim: the caller DID resolve ownership and
 * found no runtime environment — a local, SSH-owned, or otherwise
 * client-executed workspace. Collapsing the two (`args.environmentId?.trim() ??
 * focused`) silently routed those workspaces to whatever remote happened to be
 * focused, which is how a local Windows workspace ended up asking an Arch dev
 * container to open its terminal and got `selector_not_found` (#16444).
 */
export function resolveWebRuntimeSessionEnvironmentId(
  requested: string | null | undefined,
  focused: string | null | undefined
): string | null {
  if (requested === undefined) {
    return focused?.trim() || null
  }
  return requested?.trim() || null
}

export type WebRuntimeSessionWorkspaceSelection = {
  worktreeId: string | null
  executionHostId: ExecutionHostId | null
}

function selectionsMatch(
  a: WebRuntimeSessionWorkspaceSelection,
  b: WebRuntimeSessionWorkspaceSelection
): boolean {
  return a.worktreeId === b.worktreeId && a.executionHostId === b.executionHostId
}

/**
 * Whether a create that the host never accepted should hand the workspace's
 * host selection back.
 *
 * Selecting the host is a side effect of creating, not evidence that the host
 * owns the workspace. Leaving the selection behind latches the workspace to a
 * runtime that just refused it, and every later owner-routed action — the next
 * Ctrl+T included — follows the latch instead of the real owner (#16444).
 *
 * Restores only when nothing else moved the selection since; a user who
 * navigated during the failed create outranks the rollback.
 */
export function shouldRestoreWebRuntimeSessionWorkspaceSelection(args: {
  previous: WebRuntimeSessionWorkspaceSelection
  applied: WebRuntimeSessionWorkspaceSelection
  current: WebRuntimeSessionWorkspaceSelection
}): boolean {
  return (
    selectionsMatch(args.current, args.applied) && !selectionsMatch(args.previous, args.applied)
  )
}
