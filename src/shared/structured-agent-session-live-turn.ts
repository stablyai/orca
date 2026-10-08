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
// checked — Claude's turn rows are built with no linkage at all, Codex writes
// turn rows only for its primary thread (the one thread it never stamps), the
// compact row passes only a fence, and the stale-turn and dead-generation
// sweeps name no producer, so their turn revisions keep the turn row's own
// (none). So a child-linked row can never be what terminates one of these
// scans. Re-check that before giving any of those sites a producer.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem,
  type AgentJournalTurnLifecycle,
  type AgentJournalTurnScope
} from './agent-session-journal-types'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type { AgentSessionLatestTurn, AgentSessionSubscribeEvent } from './agent-session-wire'
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

/** The scope a row written now joins: the running turn, or the conversation when none runs.
 *  By sequence, for items held unordered. */
export function liveStructuredAgentSessionTurnScope(
  items: Iterable<AgentJournalRenderItem>
): AgentJournalTurnScope {
  let newest: AgentJournalRenderItem | null = null
  for (const item of items) {
    if ((newest === null || item.sequence >= newest.sequence) && readAgentJournalTurn(item.body)) {
      newest = item
    }
  }
  return newest && readAgentJournalTurn(newest.body)?.state === 'running'
    ? { kind: 'turn', turnItemId: newest.itemId }
    : AGENT_JOURNAL_THREAD_SCOPE
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
  return latestStructuredAgentSessionTurn(items)?.turn ?? null
}

/** The same record as a page publishes it, with the identity a client keys the turn by. */
export function latestStructuredAgentSessionTurn(
  items: readonly AgentJournalRenderItem[]
): AgentSessionLatestTurn | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const turn = readAgentJournalTurn(item?.body)
    if (item && turn) {
      return { itemId: item.itemId, observedAt: item.observedAt, turn }
    }
  }
  return null
}

/** The turn the session's own agent is running, for a client: the host's answer over the whole
 *  journal, which no loaded window can hide. Temporary: an older host sends none, so its clients
 *  still read the loaded rows' newest record; delete that arm once such hosts age out. */
export function runningStructuredAgentSessionTurnId(state: HostTurnSource): string | null {
  if (state.latestTurn === undefined) {
    return activeStructuredAgentSessionTurnId(state.items)
  }
  return state.latestTurn?.turn.state === 'running' ? state.latestTurn.turn.turnId : null
}

/** The scope a row of that running turn names, read the same way. */
export function runningStructuredAgentSessionTurnScope(
  state: HostTurnSource
): AgentJournalTurnScope {
  if (state.latestTurn === undefined) {
    return liveStructuredAgentSessionTurnScope(state.items)
  }
  return state.latestTurn?.turn.state === 'running'
    ? { kind: 'turn', turnItemId: state.latestTurn.itemId }
    : AGENT_JOURNAL_THREAD_SCOPE
}

type HostTurnSource = {
  items: readonly AgentJournalRenderItem[]
  latestTurn?: AgentSessionLatestTurn | null
}

/** The host's answer once `event` applies. A batch carrying rows restates it, so one without it
 *  came from an older host and falls back to the rows rather than keep a claim nothing renews. */
export function latestTurnAfterStructuredAgentSessionBatch(
  previous: AgentSessionLatestTurn | null | undefined,
  event: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
): AgentSessionLatestTurn | null | undefined {
  const { items, removedItemIds, submissions } = event.batch
  const carriesRows = items.length > 0 || removedItemIds.length > 0 || submissions.length > 0
  return carriesRows || event.latestTurn !== undefined ? event.latestTurn : previous
}

/**
 * Whether the newest thing the active turn produced is the model's own reasoning.
 *
 * This is what "thinking" has to mean for the indicator to be honest: the turn is reasoning
 * *right now*. The older rule — "the turn has produced no renderable output yet" — reports
 * thinking while the request is merely in flight, and stops reporting it the moment a tool call
 * lands, which is usually when reasoning actually starts.
 */
export function isStructuredAgentSessionThinking({ items, latestTurn }: HostTurnSource): boolean {
  // The host's answer outranks a loaded record, whose newest revision may be off the window.
  const hostRunning = latestTurn === undefined ? null : latestTurn?.turn.state === 'running'
  let newestContentIsReasoning: boolean | null = null
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const body = item?.body
    const turn = readAgentJournalTurn(body)
    if (turn) {
      return (hostRunning ?? turn.state === 'running') && newestContentIsReasoning === true
    }
    if (newestContentIsReasoning !== null || !isRootAgentJournalItem(item)) {
      continue
    }
    if (body?.kind === 'message') {
      // A row that says it ended is not reasoning now; a host that keeps no state says nothing.
      newestContentIsReasoning =
        body.role === 'reasoning' && (body.state === undefined || body.state === 'running')
    } else if (
      body?.kind === 'tool-call' ||
      body?.kind === 'diff' ||
      body?.kind === 'approval' ||
      body?.kind === 'question'
    ) {
      newestContentIsReasoning = false
    }
    // A status row is a notice, not newer transcript content.
  }
  // The record is above the loaded rows, so every loaded root row is newer than it.
  return hostRunning === true && newestContentIsReasoning === true
}

/** The tool the status row names for the SESSION'S OWN agent, as the chat draws it: the running
 *  turn's newest running call, else its newest tool action whatever it settled to, so the line
 *  never blanks mid-turn. Nothing is named unless the scan reaches a RUNNING turn record, so an
 *  ended turn's calls never surface; a mid-turn send's user row is not a boundary. */
export function statusStructuredAgentSessionToolCall(
  items: readonly AgentJournalRenderItem[]
): NativeChatToolCallBlock | null {
  let newest: { action: StructuredAgentSessionToolAction; itemId: string } | null = null
  let running: { action: StructuredAgentSessionToolAction; itemId: string } | null = null
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item) {
      continue
    }
    const body = item.body
    const turn = readAgentJournalTurn(body)
    if (turn) {
      const named = turn.state === 'running' ? (running ?? newest) : null
      // Built only for the winner: the host re-projects this on every journal change.
      return named ? structuredAgentSessionToolCallBlock(named.action, named.itemId) : null
    }
    if (running || !isStructuredAgentSessionToolAction(body) || !isRootAgentJournalItem(item)) {
      continue
    }
    newest ??= { action: body, itemId: item.itemId }
    if (isRunningStructuredAgentSessionToolAction(body)) {
      running = { action: body, itemId: item.itemId }
    }
  }
  return null
}
