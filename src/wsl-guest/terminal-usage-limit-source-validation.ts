import { terminalUsageLimitGuard } from '../shared/agent-hook-listener/terminal-usage-limit-guard'
import {
  readTerminalUsageLimitSourceRequest,
  type TerminalUsageLimitSourceResult
} from '../shared/terminal-usage-limit-source-validation'
import type { RelayInterruptHost } from './agent-hook-interrupt-reconciliation'

export function validateRelayTerminalUsageLimit(
  host: Pick<RelayInterruptHost, 'state' | 'isListening' | 'isPaneBlocked'>,
  value: unknown
): TerminalUsageLimitSourceResult {
  const request = readTerminalUsageLimitSourceRequest(value)
  if (!request || !host.isListening || host.isPaneBlocked(request.paneKey)) {
    return { status: 'unavailable' }
  }
  const row = host.state.lastStatusByPaneKey.get(request.paneKey)
  const process = row?.agentPresence?.process
  if (
    !row ||
    row.payload.agentType !== request.source ||
    row.launchToken !== request.launchToken ||
    process?.pid !== request.agentProcess?.pid ||
    process?.platform !== request.agentProcess?.platform ||
    process?.startTime !== request.agentProcess?.startTime
  ) {
    return { status: 'changed' }
  }
  const guard = terminalUsageLimitGuard(host.state, request.paneKey, request)
  return { status: guard?.() ? 'current' : 'changed' }
}
