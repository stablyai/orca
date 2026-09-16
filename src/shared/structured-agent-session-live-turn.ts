// What the newest turn in a structured journal is doing right now, read off the
// tail of the item list. Every scan here stops at the turn's own record — the
// typed `turn` item, or the legacy status row that carries one — because state
// from an earlier turn is never this turn's state.

import type {
  AgentJournalRenderItem,
  AgentJournalToolCallItem
} from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'

export function activeStructuredAgentSessionTurnId(
  items: readonly AgentJournalRenderItem[]
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const turn = readAgentJournalTurn(items[index]?.body)
    if (turn) {
      return turn.state === 'running' ? turn.turnId : null
    }
  }
  return null
}

/**
 * Whether the newest thing the active turn produced is the model's own reasoning.
 *
 * This is what "thinking" has to mean for the indicator to be honest: the turn is reasoning
 * *right now*. The older rule — "the turn has produced no renderable output yet" — reports
 * thinking while the request is merely in flight, and stops reporting it the moment a tool call
 * lands, which is usually when reasoning actually starts.
 */
export function isStructuredAgentSessionThinking(
  items: readonly AgentJournalRenderItem[]
): boolean {
  let newestContentIsReasoning: boolean | null = null
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const body = items[index]?.body
    const turn = readAgentJournalTurn(body)
    if (turn) {
      return turn.state === 'running' && newestContentIsReasoning === true
    }
    if (newestContentIsReasoning !== null) {
      continue
    }
    if (body?.kind === 'message') {
      newestContentIsReasoning = body.role === 'reasoning'
    } else if (
      body?.kind === 'tool-call' ||
      body?.kind === 'diff' ||
      body?.kind === 'approval' ||
      body?.kind === 'question'
    ) {
      newestContentIsReasoning = false
    }
    // Plain status copy is activity chrome, not newer transcript content.
  }
  return false
}

/** The tool call the newest turn is still inside, or null when nothing is running.
 *  An abandoned `running` call from an earlier crashed turn can never be reported
 *  as live work. */
export function activeStructuredAgentSessionToolCall(
  items: readonly AgentJournalRenderItem[]
): AgentJournalToolCallItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const body = items[index]?.body
    if (readAgentJournalTurn(body)) {
      return null
    }
    if (body?.kind === 'tool-call' && body.state === 'running') {
      return body
    }
  }
  return null
}
