import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentSessionUsageLimit } from '../../../../shared/agent-session/failures/agent-session-usage-limit'

export type TerminalUsageLimitNotice = {
  agent: 'claude' | 'codex'
  sessionId: string
  turnEndedAt: number
  terminal: string
  connectionId: string | null
  mainStateStartedAt: number
  turnStartedAt: number | undefined
  window: AgentSessionUsageLimit['window']
  resetsAt: number | undefined
}

/** The latest identified terminal turn owns the notice; saved/unconfirmed or child-only facts do not. */
export function terminalUsageLimitNotice(
  row: AgentStatusEntry | undefined
): TerminalUsageLimitNotice | null {
  if (
    !row ||
    row.structuredHostOwned ||
    row.restoredUnconfirmed ||
    row.sessionBoundary ||
    row.interrupted ||
    row.state !== 'done' ||
    row.mainAgent?.state !== 'done' ||
    row.mainAgent.outcome !== 'failure' ||
    row.mainAgent.usageLimit === undefined ||
    row.turnEndDisposition !== 'identified' ||
    !row.turnEndedAt ||
    !row.providerSession?.id ||
    !row.terminalHandle ||
    (row.agentType !== 'claude' && row.agentType !== 'codex')
  ) {
    return null
  }
  return {
    agent: row.agentType === 'claude' ? 'claude' : 'codex',
    sessionId: row.providerSession.id,
    turnEndedAt: row.turnEndedAt,
    terminal: row.terminalHandle,
    connectionId: row.connectionId ?? null,
    mainStateStartedAt: row.mainAgent.stateStartedAt,
    turnStartedAt: row.turnStartedAt,
    window: row.mainAgent.usageLimit.window,
    resetsAt: row.mainAgent.usageLimit.resetsAt
  }
}
