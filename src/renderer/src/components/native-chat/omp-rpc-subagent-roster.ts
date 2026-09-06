// The live subagent roster a turn's forwarded subagent frames project into.
//
// Ownership and admission rules mirror upstream's own registry
// (packages/coding-agent/src/modes/rpc/rpc-subagents.ts): a lifecycle frame for
// an unknown id is admitted only when it is a `started`, progress for an
// unknown id is dropped, and a frame whose `parentToolCallId` contradicts the
// tracked spawn is refused — two spawns can reuse an id across turns, and
// letting the wrong one win would relabel a running subagent.
//
// One deliberate divergence: upstream DELETES an entry the moment it reaches a
// terminal status, because `get_subagents` answers "what is running now". A
// chat turn is a transcript, not a live registry, so a terminal entry stays
// with its final status — otherwise a subagent that finished before the user
// looked would leave no trace of having run at all.
//
// The third frame family, `subagent_event`, carries the child's OWN session
// event stream. It projects onto the same row rather than a second surface: the
// row already answers "what is this subagent doing", and the event stream is
// the only place the child's current tool and newest line of output appear at
// all — progress aggregates status and never says either.

import type {
  OmpRpcSubagentEventPayload,
  OmpRpcSubagentLifecyclePayload,
  OmpRpcSubagentProgressPayload,
  OmpRpcSubagentStatus
} from '../../../../shared/omp-rpc-subagent-protocol'

/** Max retained roster entries for one turn; the oldest are dropped, matching
 *  the overlay's own block budget (omp-rpc-overlay-retention.ts). */
const SUBAGENT_ROSTER_MAX_ENTRIES = 64

/** Retained tail of a subagent's own streamed text. Only the newest line is
 *  ever rendered, so this is a tail window rather than the head/tail cap the
 *  parent turn's prose gets — the head of a child's stream is never read. */
export const SUBAGENT_EVENT_TEXT_TAIL_CHARS = 240

export type OmpRpcSubagentRosterEntry = {
  id: string
  index: number
  agent: string
  status: OmpRpcSubagentStatus
  description: string | undefined
  task: string | undefined
  currentTool: string | undefined
  toolCount: number | undefined
  parentToolCallId: string | undefined
  /** Spawned as a background job: it outlives the turn that started it, which
   *  is why the turn boundary keeps such an entry (omp-rpc-turn-reducer.ts). */
  detached: boolean | undefined
  /** Tail of the subagent's own streamed reply, from forwarded `subagent_event`
   *  frames. Undefined until one arrives — `progress` subscribers never see any. */
  latestText: string | undefined
  /** True while a `text_delta` that carries no accumulated `message` should
   *  extend `latestText` instead of opening a fresh tail. An assistant
   *  `message_start` clears it: the wire carries no message id, so a start is
   *  the only message boundary a snapshot-less delta run ever gets. */
  latestTextAcceptsDelta: boolean | undefined
}

const TERMINAL_SUBAGENT_STATUSES: readonly OmpRpcSubagentStatus[] = [
  'completed',
  'failed',
  'aborted'
]

/** Still doing work the user should keep seeing after the parent turn ends. */
export function isOmpRpcSubagentRunningDetached(entry: OmpRpcSubagentRosterEntry): boolean {
  return entry.detached === true && !TERMINAL_SUBAGENT_STATUSES.includes(entry.status)
}

function sameOwner(
  parentToolCallId: string | undefined,
  entry: OmpRpcSubagentRosterEntry
): boolean {
  return (
    parentToolCallId === undefined ||
    entry.parentToolCallId === undefined ||
    parentToolCallId === entry.parentToolCallId
  )
}

function withEntry(
  roster: readonly OmpRpcSubagentRosterEntry[],
  index: number,
  entry: OmpRpcSubagentRosterEntry
): OmpRpcSubagentRosterEntry[] {
  if (index !== -1) {
    return roster.map((candidate, at) => (at === index ? entry : candidate))
  }
  const appended = [...roster, entry]
  return appended.length > SUBAGENT_ROSTER_MAX_ENTRIES
    ? appended.slice(appended.length - SUBAGENT_ROSTER_MAX_ENTRIES)
    : appended
}

export function reduceOmpRpcSubagentLifecycle(
  roster: OmpRpcSubagentRosterEntry[],
  payload: OmpRpcSubagentLifecyclePayload
): OmpRpcSubagentRosterEntry[] {
  const at = roster.findIndex((entry) => entry.id === payload.id)
  const existing = at === -1 ? undefined : roster[at]
  if (existing === undefined && payload.status !== 'started') {
    return roster
  }
  if (existing && !sameOwner(payload.parentToolCallId, existing)) {
    return roster
  }
  return withEntry(roster, at, {
    id: payload.id,
    index: payload.index,
    agent: payload.agent,
    status: payload.status === 'started' ? 'running' : payload.status,
    description: payload.description ?? existing?.description,
    task: existing?.task,
    // A finished subagent is running nothing; carrying its last tool forward
    // would leave the final row claiming work that already ended.
    currentTool: payload.status === 'started' ? existing?.currentTool : undefined,
    toolCount: existing?.toolCount,
    parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
    detached: payload.detached ?? existing?.detached,
    latestText: existing?.latestText,
    latestTextAcceptsDelta: existing?.latestTextAcceptsDelta
  })
}

export function reduceOmpRpcSubagentProgress(
  roster: OmpRpcSubagentRosterEntry[],
  payload: OmpRpcSubagentProgressPayload
): OmpRpcSubagentRosterEntry[] {
  const at = roster.findIndex((entry) => entry.id === payload.progress.id)
  const existing = at === -1 ? undefined : roster[at]
  if (!existing || !sameOwner(payload.parentToolCallId, existing)) {
    return roster
  }
  return withEntry(roster, at, {
    id: payload.progress.id,
    index: payload.index,
    agent: payload.agent,
    status: payload.progress.status,
    description: payload.progress.description ?? existing.description,
    task: payload.task ?? existing.task,
    // Authoritative, not a merge: upstream clears `currentTool` on
    // `tool_execution_end` and force-flushes the snapshot, so an absent field
    // means idle rather than unchanged.
    currentTool: payload.progress.currentTool,
    toolCount: payload.progress.toolCount ?? existing.toolCount,
    parentToolCallId: payload.parentToolCallId ?? existing.parentToolCallId,
    detached: payload.detached ?? existing.detached,
    latestText: existing.latestText,
    latestTextAcceptsDelta: existing.latestTextAcceptsDelta
  })
}

/** The `text_delta` payload of a `message_update`'s optional delta half, or
 *  null when the frame carries none. Thinking deltas are excluded: a roster row
 *  reports what a subagent is doing, and its private reasoning is neither that
 *  nor something the parent pane shows for its own turn. */
function textDeltaOf(assistantMessageEvent: unknown): string | null {
  if (typeof assistantMessageEvent !== 'object' || assistantMessageEvent === null) {
    return null
  }
  const { type, delta } = assistantMessageEvent as { type?: unknown; delta?: unknown }
  return type === 'text_delta' && typeof delta === 'string' ? delta : null
}

/** Concatenated text of an assistant message's content blocks, or null when the
 *  frame's `message` is not an assistant message. Both message frames also fire
 *  for user and toolResult messages (and OMP echoes the user's own turn through
 *  `message_update`), none of which is the child's own output. */
function assistantMessageText(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) {
    return null
  }
  const { role, content } = message as { role?: unknown; content?: unknown }
  if (role !== 'assistant' || !Array.isArray(content)) {
    return null
  }
  let text = ''
  for (const block of content as readonly unknown[]) {
    if (typeof block !== 'object' || block === null) {
      continue
    }
    const { type, text: blockText } = block as { type?: unknown; text?: unknown }
    if (type === 'text' && typeof blockText === 'string') {
      text += blockText
    }
  }
  return text
}

/** Undefined rather than '' for an empty message, so the row drops the text
 *  fact entirely instead of rendering a blank one. */
function retainedTail(text: string): string | undefined {
  return text === '' ? undefined : text.slice(-SUBAGENT_EVENT_TEXT_TAIL_CHARS)
}

/** What a forwarded child event changes about its roster row, or null when the
 *  event names nothing the row shows. The inner event is the parent session's
 *  own union (untyped by construction), so each field is proven here rather
 *  than assumed. */
function subagentEventFacts(
  event: OmpRpcSubagentEventPayload['event'],
  entry: OmpRpcSubagentRosterEntry
): Partial<OmpRpcSubagentRosterEntry> | null {
  // A start never rewrites the retained text, because it cannot prove it opens
  // a message the row is not already showing. Message frames carry no id, and
  // `message.timestamp` is only a Unix ms wall clock (`AssistantMessage`,
  // packages/ai/src/types.ts): two messages minted in one tick share it and a
  // backward step inverts it, so it is neither identity nor sequence. Meanwhile
  // a start really can arrive after its own message's updates — upstream
  // delivers `message_update` straight to subscribers but gates every other
  // session event behind its extension emit and a FIFO fan-out ticket
  // (agent-session.ts `#emitSessionEvent`) — and resetting on that would erase
  // output the child already streamed.
  //
  // What the start does end is the delta-glue run below, the one message
  // boundary a snapshot-less delta stream ever gets.
  if (event.type === 'message_start') {
    if (assistantMessageText(event.message) === null) {
      return null
    }
    return entry.latestTextAcceptsDelta === true ? { latestTextAcceptsDelta: undefined } : null
  }
  if (event.type === 'message_update') {
    // Canonical `message_update` carries the message's whole accumulated
    // content, not a fragment: upstream pushes the streaming partial itself as
    // `message` on every delta (agent-loop.ts `stream.push({type:
    // "message_update", ..., message: messageSnapshot})`). The snapshot is
    // therefore authoritative over any locally glued delta run AND needs no
    // ordering fence — a later message's accumulation simply replaces an
    // earlier one's, whatever either clock says.
    const text = assistantMessageText(event.message)
    if (text !== null) {
      return { latestText: retainedTail(text), latestTextAcceptsDelta: true }
    }
    const delta = textDeltaOf(event.assistantMessageEvent)
    if (delta === null) {
      return null
    }
    // Snapshot-less delta: arrival order is all there is, and it is reliable
    // for updates alone (they bypass the gate that reorders everything else).
    const projected = entry.latestTextAcceptsDelta === true ? (entry.latestText ?? '') : ''
    return { latestText: retainedTail(projected + delta), latestTextAcceptsDelta: true }
  }
  if (event.type === 'tool_execution_start' && typeof event.toolName === 'string') {
    return { currentTool: event.toolName }
  }
  // Cleared unconditionally, as upstream does: the end frame ends whatever the
  // row was showing, and only a fresh start names a successor.
  if (event.type === 'tool_execution_end') {
    return entry.currentTool === undefined ? null : { currentTool: undefined }
  }
  return null
}

/** Projects one forwarded `subagent_event` onto its roster row. Admission
 *  mirrors progress: an event is not a spawn record, so an unknown id is
 *  dropped rather than opening a row nothing announced. */
export function reduceOmpRpcSubagentEvent(
  roster: OmpRpcSubagentRosterEntry[],
  payload: OmpRpcSubagentEventPayload
): OmpRpcSubagentRosterEntry[] {
  const at = roster.findIndex((entry) => entry.id === payload.id)
  const existing = at === -1 ? undefined : roster[at]
  if (!existing) {
    return roster
  }
  const facts = subagentEventFacts(payload.event, existing)
  return facts === null ? roster : withEntry(roster, at, { ...existing, ...facts })
}

/** The newest line of a retained child-text tail: the older lines it may
 *  straddle have already been superseded. */
function latestChildLine(latestText: string | undefined): string | undefined {
  return latestText
    ?.split('\n')
    .findLast((line) => line.trim() !== '')
    ?.trim()
}

/** One system-row line per subagent, in spawn order. Prefixed like the recap
 *  row (`※`) so the two RPC-only system rows read as one family. */
export function ompRpcSubagentRosterText(roster: readonly OmpRpcSubagentRosterEntry[]): string {
  if (roster.length === 0) {
    return ''
  }
  const lines = [...roster]
    .sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))
    .map((entry) => {
      const detail = entry.task ?? entry.description
      const tool =
        entry.currentTool === undefined
          ? undefined
          : entry.toolCount === undefined
            ? entry.currentTool
            : `${entry.currentTool} (${entry.toolCount} tools)`
      const facts = [entry.status, detail, tool, latestChildLine(entry.latestText)].filter(
        (part): part is string => part !== undefined && part !== ''
      )
      return `· ${entry.agent} — ${facts.join(' · ')}`
    })
  return ['※ subagents', ...lines].join('\n')
}
