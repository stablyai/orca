import type { ExecutionHostId } from '../../../shared/execution-host'

/** Only undefined permits focused-host fallback. Explicit null/blank means resolved without a runtime owner; collapsing these routes local/SSH workspaces to the focused remote (#16444). */
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

/** Failed creation must restore its host-selection side effect or future owner-routed actions follow the refusing runtime (#16444). Roll back only if selection still matches this create; intervening user navigation wins. */
export function shouldRestoreWebRuntimeSessionWorkspaceSelection(args: {
  previous: WebRuntimeSessionWorkspaceSelection
  applied: WebRuntimeSessionWorkspaceSelection
  current: WebRuntimeSessionWorkspaceSelection
}): boolean {
  return (
    selectionsMatch(args.current, args.applied) && !selectionsMatch(args.previous, args.applied)
  )
}
