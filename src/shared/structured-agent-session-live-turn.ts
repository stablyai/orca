// What the newest turn in a structured journal is doing right now, read off the
// tail of the item list. Every scan here stops at the turn's own record — the
// typed `turn` item, or the legacy status row that carries one — because state
// from an earlier turn is never this turn's state.
//
// These scans answer for the SESSION'S OWN agent. A subagent's rows share this
// journal and are usually the newer ones while a child runs, so each scan skips
// anything a subagent produced; the transcript still renders every agent.
//
// Each scan reads the turn record BEFORE it checks the producer, which is only
// safe because a turn row can never carry linkage: a turn is the SESSION'S unit
// of work, and no producer of a turn-bearing body stamps one. Both lanes were
// checked — Claude's turn rows are built with no linkage at all, Codex has no
// linkage concept, the compact row passes only a fence, and the stale-turn
// sweep goes through the lifecycle-batch path, which cannot carry linkage by
// type. So a child-linked row can never be what terminates one of these scans.
// Re-check that before giving any of those sites a producer.

import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import { readAgentJournalTurn } from './agent-session-turn-record'
import type { NativeChatToolCallBlock } from './native-chat-types'
import {
  isRunningStructuredAgentSessionToolAction,
  isStructuredAgentSessionToolAction,
  structuredAgentSessionToolCallBlock,
  type StructuredAgentSessionToolAction
} from './structured-agent-session-tool-call-block'

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

/** The newest turn record for items a caller holds unordered, so a reader that already has them
 *  need not render and sort a whole snapshot to ask. Sequence is the ordering key the render pass
 *  sorts on, and ties resolve to the later-reduced item exactly as that stable sort would. */
export function newestStructuredAgentSessionTurnBySequence(
  items: Iterable<AgentJournalRenderItem>
): AgentJournalTurnLifecycle | null {
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
  return newest
}

/** Whether that newest turn is still running, which is all most callers want. */
export function activeStructuredAgentSessionTurnIdBySequence(
  items: Iterable<AgentJournalRenderItem>
): string | null {
  const newest = newestStructuredAgentSessionTurnBySequence(items)
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
    const item = items[index]
    const body = item?.body
    const turn = readAgentJournalTurn(body)
    if (turn) {
      return turn.state === 'running' && newestContentIsReasoning === true
    }
    if (newestContentIsReasoning !== null || !isRootAgentJournalItem(item)) {
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

/** The tool the status row names for the SESSION'S OWN agent, as the chat draws it: the running
 *  turn's newest running call, else its newest tool action whatever it settled to, so the line
 *  never blanks mid-turn. Nothing is named unless the scan reaches a RUNNING turn record, so an
 *  ended turn's calls never surface; a mid-turn send's user row is not a boundary. */
export function statusStructuredAgentSessionToolCall(
  items: readonly AgentJournalRenderItem[]
): NativeChatToolCallBlock | null {
  let newest: StructuredAgentSessionToolAction | null = null
  let running: StructuredAgentSessionToolAction | null = null
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const body = item?.body
    const turn = readAgentJournalTurn(body)
    if (turn) {
      const named = turn.state === 'running' ? (running ?? newest) : null
      // Built only for the winner: the host re-projects this on every journal change.
      return named ? structuredAgentSessionToolCallBlock(named) : null
    }
    if (running || !isStructuredAgentSessionToolAction(body) || !isRootAgentJournalItem(item)) {
      continue
    }
    newest ??= body
    if (isRunningStructuredAgentSessionToolAction(body)) {
      running = body
    }
  }
  return null
}
