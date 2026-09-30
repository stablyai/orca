import { createHash } from 'node:crypto'
import type { HookReplayEvidence, ToolSnapshot } from '../listener-event'

/** What kind of evidence settles a prompt.
 *
 *  `completion` — Claude announces a call's `PreToolUse` BEFORE raising its `PermissionRequest`,
 *  so a `PreToolUse` is never proof that a pending approval was granted; only the call's own
 *  completion is newer evidence than the prompt.
 *  `any-tool-event` — an AskUserQuestion wait IS that call's `PreToolUse`, and answering it emits
 *  no hook of its own, so the agent announcing any further call proves it moved on. */
export type ClaudeApprovalSettlement = 'completion' | 'any-tool-event'

/** Which tool call a hook is about, from the fields every raising AND settling event carries. */
export type ClaudeToolCallIdentity = {
  readonly toolName: string
  /** Digest of the FULL tool input. Absent when the payload carried no input at all. */
  readonly inputDigest?: string
}

/** What the pane's card shows for one prompt, taken from the event that raised it. */
export type ClaudeApprovalCard = Pick<ToolSnapshot, 'toolName' | 'toolInput' | 'interactivePrompt'>

/** One prompt Claude raised on a pane and has not been observed answering for. */
export type ClaudeApprovalRecord = ClaudeToolCallIdentity & {
  /** Subagent that owns the prompt; absent for the lead session. */
  readonly agentId?: string
  /** Only when the raising event carried one. `PermissionRequest` never does. */
  readonly toolUseId?: string
  readonly settledBy: ClaudeApprovalSettlement
  readonly card: ClaudeApprovalCard
}

/** A tool call announced or completed on a pane, as the ledger reads it. */
export type ClaudeToolCallObservation = ClaudeToolCallIdentity & {
  readonly agentId?: string
  readonly toolUseId?: string
  /** True for `PostToolUse` / `PostToolUseFailure`. */
  readonly completesCall: boolean
}

/** Generous for any real parallel batch; a runaway producer sheds its oldest rather than growing. */
const MAX_CLAUDE_APPROVAL_RECORDS = 8
const MAX_CALL_KEY_DEPTH = 12

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalizeToolInput(value: unknown, depth: number): unknown {
  if (depth >= MAX_CALL_KEY_DEPTH) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeToolInput(entry, depth + 1))
  }
  if (!isRecord(value)) {
    return value
  }
  const canonical: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    canonical[key] = canonicalizeToolInput(value[key], depth + 1)
  }
  return canonical
}

/** Identity of a tool call from the fields every raising AND settling hook carries.
 *
 *  Claude's `PermissionRequest` payload has no `tool_use_id` (measured on CLI 2.1.270; reported
 *  the same on 2.1.220/2.1.221), so the tool name plus the FULL tool input is the only pairing
 *  key that is always present. Orca's `toolInput` preview is not usable here — it is clipped at
 *  160 characters and absent for MCP/Task/TodoWrite, which would make siblings indistinguishable. */
function claudeToolCallIdentity(toolName: unknown, toolInput: unknown): ClaudeToolCallIdentity {
  const name = typeof toolName === 'string' ? toolName.trim() : ''
  if (toolInput === undefined) {
    return { toolName: name }
  }
  let serialized: string
  try {
    serialized = JSON.stringify(canonicalizeToolInput(toolInput, 0)) ?? '\u0000absent'
  } catch {
    // Why: an input this cannot serialize is no identity at all — degrade to the tool name.
    return { toolName: name }
  }
  return { toolName: name, inputDigest: createHash('sha256').update(serialized).digest('hex') }
}

/** Stable map key for the announced-call registry. */
function announcedCallKey(agentId: string | undefined, call: ClaudeToolCallIdentity): string {
  return `${agentId ?? ''}\u0000${call.toolName}\u0000${call.inputDigest ?? ''}`
}

function sameCall(entry: ClaudeToolCallIdentity, observed: ClaudeToolCallIdentity): boolean {
  if (entry.toolName !== observed.toolName) {
    return false
  }
  // Why: one side never reported an input (a PostToolUse may carry only its tool_response), so the
  // tool name is the whole identity available. A conflicting tool_use_id still refuses above.
  if (entry.inputDigest === undefined || observed.inputDigest === undefined) {
    return true
  }
  return entry.inputDigest === observed.inputDigest
}

function sameOwner(entryAgentId: string | undefined, observedAgentId: string | undefined): boolean {
  return (entryAgentId ?? '') === (observedAgentId ?? '')
}

function settles(entry: ClaudeApprovalRecord, observed: ClaudeToolCallObservation): boolean {
  if (!sameOwner(entry.agentId, observed.agentId)) {
    return false
  }
  if (!observed.completesCall) {
    return entry.settledBy === 'any-tool-event'
  }
  // Why: two ids are an exact answer, so a sibling completion can never stand in for the prompt.
  if (entry.toolUseId !== undefined && observed.toolUseId !== undefined) {
    return entry.toolUseId === observed.toolUseId
  }
  return sameCall(entry, observed)
}

function sameApproval(a: ClaudeApprovalRecord, b: ClaudeApprovalRecord): boolean {
  return (
    sameOwner(a.agentId, b.agentId) &&
    a.toolName === b.toolName &&
    a.inputDigest === b.inputDigest &&
    a.toolUseId === b.toolUseId &&
    a.settledBy === b.settledBy
  )
}

/** The pane is paused for exactly as long as this is true, and for no other reason. */
export function claudeHasOutstandingApproval(
  records: readonly ClaudeApprovalRecord[] | undefined
): boolean {
  return (records ?? []).length > 0
}

/** The card of the newest prompt still outstanding (Claude 2.1.284 showed the newest queued dialog
 *  first); an answered prompt's text must never stand in for the one still on screen. */
export function claudeLiveApprovalCard(
  records: readonly ClaudeApprovalRecord[] | undefined
): ClaudeApprovalCard | undefined {
  return records?.at(-1)?.card
}

/** Only children are owed answers, so the pane is paused but the main agent itself is not. */
export function claudeWaitIsChildOwned(
  records: readonly ClaudeApprovalRecord[] | undefined
): boolean {
  return (
    claudeHasOutstandingApproval(records) &&
    (records ?? []).every((record) => record.agentId !== undefined)
  )
}

export function claudeApprovalOwnedBy(
  records: readonly ClaudeApprovalRecord[] | undefined,
  ownsWait: (agentId: string) => boolean
): boolean {
  return (records ?? []).some((record) => record.agentId !== undefined && ownsWait(record.agentId))
}

/** Settle every prompt an agent owns, for the lifecycle events that end it outright. */
export function settleClaudeApprovalsOwnedBy(
  records: readonly ClaudeApprovalRecord[] | undefined,
  ownsWait: (agentId: string) => boolean
): readonly ClaudeApprovalRecord[] {
  const existing = records ?? []
  const remaining = existing.filter(
    (record) => record.agentId === undefined || !ownsWait(record.agentId)
  )
  return remaining.length === existing.length ? existing : remaining
}

/** `tool_use_id` Claude announced for each distinct call of the current turn.
 *
 *  A `PermissionRequest` carries no id, so without this a prompt could only ever be matched by
 *  its call identity — and a sibling completion of a byte-identical call would answer for it.
 *  Adopting the announced id makes a conflicting completion refusable. `null` records an AMBIGUOUS
 *  key (two announced calls, same tool and same input) where no id may be adopted, so ambiguity
 *  degrades to call-identity matching instead of guessing an owner. Turn-scoped and capped, so
 *  neither real ids nor ambiguity markers can accumulate across a session. */
export type ClaudeAnnouncedCalls = Readonly<Record<string, string | null>>

const MAX_ANNOUNCED_CALLS = 32

function recordAnnouncedCall(
  announced: ClaudeAnnouncedCalls | undefined,
  key: string,
  toolUseId: string
): ClaudeAnnouncedCalls {
  const existing = announced ?? {}
  const recorded = existing[key]
  if (recorded === toolUseId || recorded === null) {
    return existing
  }
  const next: Record<string, string | null> = { ...existing }
  next[key] = recorded === undefined ? toolUseId : null
  const keys = Object.keys(next)
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ANNOUNCED_CALLS))) {
    delete next[stale]
  }
  return next
}

/** The boundaries that end a turn's prompts wholesale: a typed prompt and the main agent's turn
 *  end. A session start, a child's end, an inferred interrupt and a typed question answer settle
 *  prompts outside this fold. Returns undefined when the event is not a boundary. */
function sweepClaudeApprovalsAtTurnBoundary(
  records: readonly ClaudeApprovalRecord[],
  agentId: string | undefined,
  opensUserTurn: boolean,
  mainAgentTurnEnd: ClaudeMainAgentTurnEnd | undefined
): readonly ClaudeApprovalRecord[] | undefined {
  // Why: a child's own prompt or turn end ends nothing of the main agent's turn.
  if (agentId !== undefined) {
    return undefined
  }
  if (opensUserTurn) {
    return []
  }
  if (mainAgentTurnEnd) {
    // Why: the main agent's turn ending answers none of a background child's prompts, but one
    // outlives it only while that child's work does; a child the inventory retired asks nothing.
    const survivors = records.filter(
      (record) => record.agentId !== undefined && mainAgentTurnEnd.childOutlivesTurn(record.agentId)
    )
    return survivors.length === records.length ? records : survivors
  }
  return undefined
}

/** The main agent's turn ended (Stop, StopFailure, a manual compact). */
export type ClaudeMainAgentTurnEnd = {
  /** Whether a child's prompt outlives the turn, judged after this event's inventory. */
  readonly childOutlivesTurn: (agentId: string) => boolean
}

/** What the previous lead-turn record carries into this event's fold. */
export type ClaudeApprovalCarryover = {
  readonly approvals?: readonly ClaudeApprovalRecord[]
  readonly announcedCalls?: ClaudeAnnouncedCalls
}

/** Everything one hook event says about the pane's outstanding prompts. */
export type ClaudeApprovalFold = {
  /** This event's tool call, when it is one. */
  readonly toolCall?: ClaudeToolCallObservation
  /** Per-call ids announced so far this turn, including this event's. */
  readonly announcedCalls?: ClaudeAnnouncedCalls
  /** The ledger after this event: settlement, raise and turn-end sweep all applied. */
  readonly approvals: readonly ClaudeApprovalRecord[]
}

/** Whether an event may raise a wait. A replay normally may not: Orca's hook transport is
 *  at-least-once, and the shell spool skips PreToolUse/PostToolUse, so it can re-deliver a prompt
 *  whose POST timed out while never re-delivering the completion that settled it — a wait nothing
 *  could discharge. The exception is a prompt spooled after the pane's last observation, i.e. while
 *  no listener was up: its dialog is almost certainly still on screen, and the answer can only come
 *  once this runtime is live, so its completion arrives live. The spool's whole-second clock fails
 *  toward not raising; a relay supplies no times, so its replays never raise. */
export function claudeReplayMayRaiseWait(replay: HookReplayEvidence | undefined): boolean {
  return (
    replay === undefined ||
    (replay.observedAt !== undefined &&
      replay.lastLiveAt !== undefined &&
      replay.observedAt > replay.lastLiveAt)
  )
}

/** Derive the pane's outstanding prompts from one hook event, with no latch behind them: a prompt
 *  exists because it was raised and has not been answered for, and nothing else. */
export function foldClaudeApprovalEvent(input: {
  carriedOver: ClaudeApprovalCarryover | undefined
  eventName: unknown
  agentId?: string
  toolUseId?: string
  toolName: unknown
  toolInput: unknown
  /** This event puts the pane in a human-input wait. */
  raisesWait: boolean
  /** The card the raised prompt shows; read only when `raisesWait`. */
  raisedCard?: ClaudeApprovalCard
  /** That wait is an AskUserQuestion, which IS its call's PreToolUse rather than following it. */
  raisesQuestionWait: boolean
  /** Present when this event ends the main agent's turn. */
  mainAgentTurnEnd?: ClaudeMainAgentTurnEnd
  /** A prompt the user typed, which opens a new turn. A harness-injected `UserPromptSubmit` does not:
   *  it arrives inside the running turn (reusing its prompt_id) and answers no permission prompt. */
  opensUserTurn: boolean
  /** Present for a durable re-delivery of an event from a prior runtime. */
  replay?: HookReplayEvidence
}): ClaudeApprovalFold {
  const { carriedOver, eventName, agentId, toolUseId } = input
  const call = claudeToolCallIdentity(input.toolName, input.toolInput)
  const completesCall = eventName === 'PostToolUse' || eventName === 'PostToolUseFailure'
  const toolCall =
    eventName === 'PreToolUse' || completesCall
      ? {
          ...call,
          ...(agentId !== undefined ? { agentId } : {}),
          ...(toolUseId !== undefined ? { toolUseId } : {}),
          completesCall
        }
      : undefined
  const swept = sweepClaudeApprovalsAtTurnBoundary(
    carriedOver?.approvals ?? [],
    agentId,
    input.opensUserTurn,
    input.mainAgentTurnEnd
  )
  if (swept) {
    // Why: whatever the turn never answered for died with it, and nothing may be inherited by the
    // next turn — no TTL, no timer, just the boundary that already exists.
    return { ...(toolCall ? { toolCall } : {}), approvals: swept }
  }
  const key = announcedCallKey(agentId, call)
  // Why: record what Claude announced for this call BEFORE the prompt that follows it, so a
  // permission request the CLI gives no `tool_use_id` can still adopt one and refuse a sibling.
  const announcedCalls =
    eventName === 'PreToolUse' && toolUseId !== undefined
      ? recordAnnouncedCall(carriedOver?.announcedCalls, key, toolUseId)
      : carriedOver?.announcedCalls
  const carried = {
    ...(toolCall ? { toolCall } : {}),
    ...(announcedCalls ? { announcedCalls } : {})
  }
  const settled = settleObservedCall(
    carriedOver?.approvals ?? [],
    // Why: the main agent taking an injected prompt has moved past its own question, as a new call would show.
    toolCall ??
      (eventName === 'UserPromptSubmit' && agentId === undefined
        ? { toolName: '', completesCall: false }
        : undefined)
  )
  if (!input.raisesWait || !claudeReplayMayRaiseWait(input.replay)) {
    return { ...carried, approvals: settled }
  }
  const announcedOwner = announcedCalls?.[key]
  const raised: ClaudeApprovalRecord = {
    ...call,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(toolUseId !== undefined
      ? { toolUseId }
      : typeof announcedOwner === 'string'
        ? { toolUseId: announcedOwner }
        : {}),
    settledBy: input.raisesQuestionWait ? 'any-tool-event' : 'completion',
    card: input.raisedCard ?? {}
  }
  // Why: a duplicate delivery of the same live prompt must not stack a second obligation — unless
  // this turn announced two identical calls, where a second prompt is real and merging would hide it.
  if (announcedOwner !== null && settled.some((record) => sameApproval(record, raised))) {
    return { ...carried, approvals: settled }
  }
  const next = [...settled, raised]
  return {
    ...carried,
    approvals:
      next.length > MAX_CLAUDE_APPROVAL_RECORDS
        ? next.slice(next.length - MAX_CLAUDE_APPROVAL_RECORDS)
        : next
  }
}

/** Settle at most one record — the oldest this observation answers for. */
function settleObservedCall(
  records: readonly ClaudeApprovalRecord[],
  observed: ClaudeToolCallObservation | undefined
): readonly ClaudeApprovalRecord[] {
  if (!observed) {
    return records
  }
  const index = records.findIndex((record) => settles(record, observed))
  return index === -1 ? records : [...records.slice(0, index), ...records.slice(index + 1)]
}
