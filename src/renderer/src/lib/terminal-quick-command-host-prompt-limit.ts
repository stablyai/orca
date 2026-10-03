import type { AppState } from '@/store/types'
import { terminalQuickCommandAgentPromptMaxLength } from '../../../shared/terminal-quick-command-prompt-limit'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'

/** An older host's agent-prompt character cap, read from its live status; `null` for none. */
export function getTerminalQuickCommandHostPromptMaxLength(
  state: Pick<AppState, 'runtimeStatusByEnvironmentId'>,
  hostId: ExecutionHostId
): number | null {
  const parsed = parseExecutionHostId(hostId)
  if (!parsed || parsed.kind !== 'runtime') {
    return null
  }
  return terminalQuickCommandAgentPromptMaxLength(
    lastVerifiedRuntimeStatus(state.runtimeStatusByEnvironmentId.get(parsed.environmentId))
      ?.capabilities
  )
}
