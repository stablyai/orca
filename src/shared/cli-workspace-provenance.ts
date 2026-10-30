import type { TuiAgent } from './tui-agent'
import type { CliWorkspaceProvenance } from './worktree/types'

/** CLI create context is descriptive; host-stamped createdAt prevents skewed client clocks changing sort order. */
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
