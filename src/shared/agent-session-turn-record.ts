// One reader for the turn record in both of its journal shapes: the `turn`
// item this build writes, and the status row with `turnLifecycle` that older
// hosts wrote and that older clients still receive.

import type {
  AgentJournalItemBody,
  AgentJournalStatusItem,
  AgentJournalTurnItem,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import { agentTurnLifecycleText } from './agent-turn-lifecycle-text'

export function readAgentJournalTurn(
  body: AgentJournalItemBody | undefined
): AgentJournalTurnLifecycle | null {
  if (!body) {
    return null
  }
  if (body.kind === 'turn') {
    const { kind: _kind, ...turn } = body
    return turn
  }
  return body.kind === 'status' ? (body.turnLifecycle ?? null) : null
}

export function isRunningAgentJournalTurn(body: AgentJournalItemBody | undefined): boolean {
  return readAgentJournalTurn(body)?.state === 'running'
}

export function agentJournalTurnBody(turn: AgentJournalTurnLifecycle): AgentJournalTurnItem {
  return { kind: 'turn', ...turn }
}

/** The pre-v3 carrier, for clients that predate the `turn` item. The agent name
 *  comes from the lifecycle identity (`legacy:<agent>:…`). */
export function legacyAgentJournalTurnStatusBody(
  turn: AgentJournalTurnLifecycle,
  itemId: string
): AgentJournalStatusItem {
  const agent = itemId.startsWith('legacy:claude:') ? 'Claude' : 'Codex'
  return { kind: 'status', text: agentTurnLifecycleText(agent, turn.state), turnLifecycle: turn }
}
