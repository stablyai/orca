import { ClaudeTerminalInterruptTracker } from '../shared/claude-terminal-interrupt'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { AGENT_STATUS_STALE_AFTER_MS } from '../shared/agent-status-types'
import {
  applyRelayClaudeInterrupt,
  type RelayInterruptHost
} from './agent-hook-interrupt-reconciliation'

export function createRelayClaudeTerminalInterrupts(
  state: HookListenerState,
  readHost: () => RelayInterruptHost
): ClaudeTerminalInterruptTracker<AgentHookEventPayload> {
  return new ClaudeTerminalInterruptTracker(
    (paneKey) => state.lastStatusByPaneKey.get(paneKey),
    (row) => {
      const host = readHost()
      const meta = host.getMetadata(row.paneKey)
      const expectedLaunchToken = host.getAgentLaunchToken(row.paneKey)
      if (
        !host.isListening ||
        !meta ||
        meta.source !== 'claude' ||
        host.isPaneBlocked(row.paneKey) ||
        Date.now() - (row.hostEvidenceObservedAt ?? 0) > AGENT_STATUS_STALE_AFTER_MS ||
        (expectedLaunchToken !== undefined && row.launchToken !== expectedLaunchToken)
      ) {
        return
      }
      applyRelayClaudeInterrupt(host, row, meta)
    }
  )
}
