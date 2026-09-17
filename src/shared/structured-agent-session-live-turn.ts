// What the newest turn in a structured journal is doing right now, read off the
// tail of the item list. Every scan here stops at the turn's own record — the
// typed `turn` item, or the legacy status row that carries one — because state
// from an earlier turn is never this turn's state.

import type {
  AgentJournalRenderItem,
  AgentJournalToolCallItem,
  AgentJournalTurnLifecycle
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

/** The same verdict for reduced items a caller holds unordered, so a reader that already has them
 *  need not render and sort a whole snapshot to ask. Sequence is the ordering key the render pass
 *  sorts on, and ties resolve to the later-reduced item exactly as that stable sort would. */
export function activeStructuredAgentSessionTurnIdBySequence(
  items: Iterable<AgentJournalRenderItem>
): string | null {
  let newestSequence = 0
  let newest: AgentJournalTurnLifecycle | null = null
  for (const item of items) {
    if (item.sequence < newestSequence) {
      continue
    }
    const turn = readAgentJournalTurn(item.body)
    if (turn) {
      newestSequence = item.sequence
      newest = turn
    }
  }
  return newest?.state === 'running' ? newest.turnId : null
}

/** The newest turn record whatever state it ended in, STATE INCLUDED. Restart resume compares both
 *  halves against the teardown marker: the id alone cannot tell a turn that was interrupted from
 *  one that finished, and offering a finished chat is the failure this feature exists to avoid.
 *  The running-only readers above would answer null for exactly the sessions this has to identify,
 *  because eviction settles them to `interrupted`.
 *
 *  Scans backwards rather than by sequence because every caller passes a rendered snapshot, which
 *  is already in that order. Use the by-sequence reader above for items held unordered. */
export function newestStructuredAgentSessionTurn(
  items: readonly AgentJournalRenderItem[]
): AgentJournalTurnLifecycle | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const turn = readAgentJournalTurn(items[index]?.body)
    if (turn) {
      return turn
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
