// Projects an OMP RPC turn's accumulated state into the messages NativeChat
// splices in at the streaming bubble's position. Split from the reducer (the
// state machine) because this is the render-time question — "what does the
// transcript not yet cover?" — and it needs the transcript, which the reducer
// never sees.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  nativeChatOverlayLeadsTranscriptContent,
  nativeChatOverlayLeadsTranscriptReasoning,
  OMP_RPC_OVERLAY_ID_PREFIX
} from '../../../../shared/native-chat-streaming'
import { ompAdvisorNotesText } from '../../../../shared/omp-advisor-notes'
import {
  nativeChatWindowOmitsOlderRecords,
  type NativeChatTranscriptWindow
} from './native-chat-pagination'
import { ompRpcSubagentRosterText } from './omp-rpc-subagent-roster'
import type { OmpRpcTurnState } from './omp-rpc-turn-reducer'

// Every id here starts with OMP_RPC_OVERLAY_ID_PREFIX, which is what puts the
// whole overlay in the live-tail sort tier instead of at the conversation head
// (XLR-007) — the rows carry no clock, and the list's comparator reads a null
// timestamp as negative infinity, so without the tier they sorted ahead of all
// timestamped history and could be scrolled off screen entirely.
export const OMP_RPC_OVERLAY_ASSISTANT_ID = `${OMP_RPC_OVERLAY_ID_PREFIX}assistant`
/** Named as the assistant row's split sibling on purpose: within the tier every
 *  clockless row ties, and the comparator's existing `${id}:reasoning` rule is
 *  what then keeps "thinking" ahead of the reply — the same shape the omp
 *  transcript decoder mints for the same pair. */
export const OMP_RPC_OVERLAY_REASONING_ID = `${OMP_RPC_OVERLAY_ASSISTANT_ID}:reasoning`
export const OMP_RPC_RECAP_ID_PREFIX = `${OMP_RPC_OVERLAY_ID_PREFIX}recap-`
export const OMP_RPC_COMMAND_OUTPUT_ID = `${OMP_RPC_OVERLAY_ID_PREFIX}command-output`
export const OMP_RPC_SUBAGENT_ROSTER_ID = `${OMP_RPC_OVERLAY_ID_PREFIX}subagent-roster`
export const OMP_RPC_ADVISOR_ID_PREFIX = `${OMP_RPC_OVERLAY_ID_PREFIX}advisor-`

/** toolCallIds already present in the transcript, so an overlay tool block the
 *  transcript tailer has already surfaced is never rendered twice (F8) —
 *  checked per block, never as a single all-or-nothing decision from
 *  concatenated text.
 *
 *  Kept per block TYPE, because one call lands as two independent transcript
 *  rows (the call on the assistant message, the result on its own tool message
 *  — transcript-line-decoders-omp.ts) and the tailer can persist the first
 *  well before the second. Treating either row as coverage of both would blank
 *  a live streaming result the transcript has not caught up to yet. */
function transcriptToolCallIds(messages: readonly NativeChatMessage[]): {
  calls: Set<string>
  results: Set<string>
} {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool-call' && block.toolCallId) {
        calls.add(block.toolCallId)
      }
      if (block.type === 'tool-result' && block.toolCallId) {
        results.add(block.toolCallId)
      }
    }
  }
  return { calls, results }
}

function transcriptTurnIds(messages: readonly NativeChatMessage[]): Set<string> {
  const turnIds = new Set<string>()
  for (const message of messages) {
    if (message.turnId !== undefined) {
      turnIds.add(message.turnId)
    }
  }
  return turnIds
}

/** The oldest instant the loaded transcript window still holds, or null when
 *  nothing in it is clocked. Minimum rather than the first element's stamp so
 *  an unclocked head row (null sorts first — native-chat-types.ts) cannot hide
 *  the horizon.
 *
 *  Transcript-sourced records ONLY (XLR-R6-006, cross-lab review): the list this
 *  reads has RPC-hydrated history merged into it
 *  (native-chat-rpc-history-merge.ts), and that snapshot reaches back further
 *  than the bounded transcript read — while `omitsOlderRecords` is a
 *  measurement of the transcript window alone. Counting a hydrated row dragged
 *  the horizon back behind the real window start, so a card sitting inside the
 *  scrolled-past region never cleared it and reappeared as fresh advice on
 *  every Chat-view remount. Hydrated rows are tagged `rpc` by the decoder
 *  (omp-rpc-history-decode.ts) and the merge keeps the transcript's own copy of
 *  every record both windows carry, so the measured window survives this
 *  filter intact. */
function transcriptWindowStart(messages: readonly NativeChatMessage[]): number | null {
  let oldest: number | null = null
  for (const message of messages) {
    if (message.source !== 'transcript' || message.timestamp === null) {
      continue
    }
    if (oldest === null || message.timestamp < oldest) {
      oldest = message.timestamp
    }
  }
  return oldest
}

/**
 * Advisor cards the transcript has accounted for, in card order. Two shapes
 * count, and both mean the same thing — the overlay's copy is no longer the
 * only carrier of this note:
 *
 * 1. The window carries a row under the card's turnId. The ordinary case.
 * 2. The window provably omits older records AND its oldest row is strictly
 *    NEWER than the card. SA-005: coverage can only be observed while the Chat
 *    view is mounted, but the card lives on the pane-anchored RPC ownership
 *    that survives that view's unmount (use-omp-rpc-chat-pane-ownership.ts).
 *    Leave Chat right after an advisor frame and the covering row is never
 *    seen; by the time Chat reopens, later records have pushed that row out of
 *    the bounded window (native-chat-pagination.ts) and no turnId left in it
 *    can ever match, so rule 1 alone would render the card forever as fresh
 *    advice. A truncated window that begins after the card is standing proof
 *    its row is behind the window, not ahead of it.
 *
 *    The truncation half is load-bearing (SA-007): on a window that reaches
 *    the head of the transcript nothing has been dropped, so a row newer than
 *    the card is just the ordinary race — message_end lands before the tailer
 *    persists the advisor entry — and retiring there would destroy the only
 *    copy of advice the user never saw. `transcriptWindow` is omitted by
 *    callers that hold no such proof, and rule 2 then never fires.
 *
 *    Strict `<`, so a card sitting exactly on the window boundary is left to
 *    rule 1; and only for a clocked card, since a carrier that dropped the
 *    timestamp gives nothing to compare (that degenerate card still retires by
 *    rule 1).
 *
 * Both rules also gate the render below, not just the retirement dispatch:
 * the dispatch runs in an effect, so a render-time gate that disagreed would
 * flash the stale card for a frame on every reopen.
 */
export function selectOmpRpcRetirableAdvisorTurnIds(
  state: OmpRpcTurnState,
  transcriptMessages: readonly NativeChatMessage[],
  transcriptWindow?: NativeChatTranscriptWindow | null
): string[] {
  if (state.advisorCards.length === 0) {
    return []
  }
  const covered = transcriptTurnIds(transcriptMessages)
  const windowStart = nativeChatWindowOmitsOlderRecords(transcriptWindow)
    ? transcriptWindowStart(transcriptMessages)
    : null
  return state.advisorCards
    .filter(
      (card) =>
        covered.has(card.turnId) ||
        (windowStart !== null && card.timestamp !== null && card.timestamp < windowStart)
    )
    .map((card) => card.turnId)
}

/** In-progress overlay messages to render, gated by content-only leads-vs-
 *  transcript coverage (F13/W6-1) — never the binary `working` flag. A turn
 *  completing (agent_end) and the transcript tailer surfacing that same turn
 *  race independently (RPC's agent_end has no debounce; the transcript path
 *  has a 150ms filesystem-watcher debounce plus IPC plus a re-render), so
 *  gating on `working` blanked the just-finished reply and then reflowed it
 *  back in once the transcript caught up. The overlay now fades out only
 *  once content coverage says so, whether or not the turn is still working;
 *  `working` remains the D5 status/Stop signal (`isOmpRpcTurnActive`) and is
 *  not read here. Order: reasoning before the reply, matching how a
 *  "thinking" bubble reads before the assistant's answer. Text and tool
 *  blocks are gated independently (F8): a tool-first turn (empty
 *  assistantText) still shows its in-flight tool blocks, and a text-length
 *  tie against the transcript hides only the text block, not tool blocks the
 *  transcript hasn't caught up to yet. */
export function selectOmpRpcOverlayMessages(
  state: OmpRpcTurnState,
  transcriptMessages: readonly NativeChatMessage[],
  transcriptWindow?: NativeChatTranscriptWindow | null
): NativeChatMessage[] {
  const messages: NativeChatMessage[] = []
  if (
    state.reasoningText.trim() &&
    nativeChatOverlayLeadsTranscriptReasoning({
      messages: transcriptMessages,
      overlayText: state.reasoningText
    })
  ) {
    messages.push({
      id: OMP_RPC_OVERLAY_REASONING_ID,
      role: 'reasoning',
      blocks: [{ type: 'text', text: state.reasoningText }],
      timestamp: null,
      source: 'rpc'
    })
  }
  const textLeads =
    state.assistantText.trim().length > 0 &&
    nativeChatOverlayLeadsTranscriptContent({
      messages: transcriptMessages,
      overlayText: state.assistantText
    })
  const known = transcriptToolCallIds(transcriptMessages)
  const visibleBlocks = state.blocks.filter((block) => {
    if (block.type === 'text') {
      return textLeads
    }
    if (block.type === 'tool-call') {
      return !(block.toolCallId && known.calls.has(block.toolCallId))
    }
    if (block.type === 'tool-result') {
      return !(block.toolCallId && known.results.has(block.toolCallId))
    }
    return true
  })
  if (visibleBlocks.length > 0) {
    messages.push({
      id: OMP_RPC_OVERLAY_ASSISTANT_ID,
      role: 'assistant',
      blocks: visibleBlocks,
      timestamp: null,
      source: 'rpc'
    })
  }
  if (state.commandOutputText.trim() && !state.commandInvokedAgent) {
    messages.push({
      id: OMP_RPC_COMMAND_OUTPUT_ID,
      role: 'system',
      blocks: [{ type: 'text', text: state.commandOutputText }],
      timestamp: null,
      source: 'rpc'
    })
  }
  // No leads-vs-transcript gate: the roster is live spawn state OMP forwards
  // only over RPC, so nothing in the transcript can ever cover it and there is
  // no second copy to race.
  const subagentRoster = ompRpcSubagentRosterText(state.subagents)
  if (subagentRoster) {
    messages.push({
      id: OMP_RPC_SUBAGENT_ROSTER_ID,
      role: 'system',
      blocks: [{ type: 'text', text: subagentRoster }],
      timestamp: null,
      source: 'rpc'
    })
  }
  // Unlike the roster, an advisor card DOES reach the transcript — as its own
  // `customType:'advisor'` entry — so the overlay must withdraw its copy once
  // the transcript accounts for it, or the same note renders twice.
  // Withdrawing is only this render's answer: the same set goes back to the
  // reducer (`advisor-cards-covered`), which retires the card so a later,
  // shorter transcript window cannot resurrect it.
  const accountedFor = new Set(
    selectOmpRpcRetirableAdvisorTurnIds(state, transcriptMessages, transcriptWindow)
  )
  for (const card of state.advisorCards) {
    if (accountedFor.has(card.turnId)) {
      continue
    }
    messages.push({
      id: `${OMP_RPC_ADVISOR_ID_PREFIX}${card.turnId}`,
      role: 'system',
      blocks: [{ type: 'text', text: ompAdvisorNotesText(card.notes) }],
      timestamp: card.timestamp,
      source: 'rpc',
      turnId: card.turnId
    })
  }
  if (state.latestRecap?.text.trim()) {
    messages.push({
      id: `${OMP_RPC_RECAP_ID_PREFIX}${state.latestRecap.timestamp}`,
      role: 'system',
      blocks: [{ type: 'text', text: `※ recap: ${state.latestRecap.text.trim()}` }],
      timestamp: state.latestRecap.timestamp,
      source: 'rpc'
    })
  }
  return messages
}
