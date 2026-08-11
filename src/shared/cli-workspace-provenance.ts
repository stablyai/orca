import type { CliWorkspaceProvenance, TuiAgent } from './types'

/** Client-supplied context for a `orca worktree create`. Descriptive only —
 *  the host stamps `createdAt` so a skewed client clock can't affect sort order. */
export type CliWorkspaceProvenanceRequest = {
  callerTerminalHandle?: string
}

export function buildCliWorkspaceProvenance(
  request: CliWorkspaceProvenanceRequest | undefined,
  options: { startupAgent?: TuiAgent; createdAt: number }
): CliWorkspaceProvenance | undefined {
  if (!request) {
    return undefined
  }
  return {
    kind: 'created-by-cli',
    createdAt: options.createdAt,
    ...(request.callerTerminalHandle ? { callerTerminalHandle: request.callerTerminalHandle } : {}),
    ...(options.startupAgent ? { startupAgent: options.startupAgent } : {})
  }
}
