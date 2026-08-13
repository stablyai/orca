// ─── Native chat conversation model (cross-process, IPC-serializable) ────────
// The single renderer-facing conversation contract for the native chat view.
// Assembled from layered sources in priority order: on-disk JSONL transcripts,
// live agent-hook events, and (as a degraded fallback) scrollback scrape — see
// docs/plans/2026-06-17-001-feat-native-chat-view-plan.md (KTD2). Everything
// here must be plain JSON: these values cross the IPC boundary, so no class
// instances, Maps, or Dates.

import type { AgentType } from './agent-status-types'

export type { AgentType }

/** Where a message came from. Used for dedup precedence: a transcript message
 *  supersedes a hook message, which supersedes a scrape message. */
export const NATIVE_CHAT_SOURCES = ['transcript', 'hook', 'scrape'] as const
export type NativeChatSource = (typeof NATIVE_CHAT_SOURCES)[number]

/** Priority rank for a source — higher wins when two sources describe the same
 *  turn. Kept as data so the assembler's precedence is a single lookup, not a
 *  chain of conditionals. */
export const NATIVE_CHAT_SOURCE_PRIORITY: Record<NativeChatSource, number> = {
  transcript: 3,
  hook: 2,
  scrape: 1
}

export const NATIVE_CHAT_ROLES = ['user', 'assistant', 'tool', 'reasoning', 'system'] as const
export type NativeChatRole = (typeof NATIVE_CHAT_ROLES)[number]

/** Plain prose / markdown. The assistant body, a user prompt, reasoning text. */
export type NativeChatTextBlock = {
  type: 'text'
  text: string
}

/** A tool invocation by the agent. `input` is the (already-serialized) tool
 *  argument payload; kept as `unknown` because each tool's shape differs and
 *  the renderer only previews it. */
export type NativeChatToolCallBlock = {
  type: 'tool-call'
  name: string
  input: unknown
}

/** The result returned to the agent for a prior tool call. */
export type NativeChatToolResultBlock = {
  type: 'tool-result'
  output: string
  isError?: boolean
}

/** A reference to an image, by local path or remote URL. Exactly the field
 *  that applies is populated; `alt` is optional descriptive text. */
export type NativeChatImageRefBlock = {
  type: 'image-ref'
  path?: string
  url?: string
  alt?: string
}

export type NativeChatBlock =
  | NativeChatTextBlock
  | NativeChatToolCallBlock
  | NativeChatToolResultBlock
  | NativeChatImageRefBlock

/** Distinguishes a synthesized `role: 'system'` notice from an ordinary quiet
 *  aside (e.g. the interrupted-turn marker). `'login-required'` gets an
 *  actionable card in the renderer; `'generic'` gets a plain descriptive
 *  banner. Optional and additive — absent on every message the assembler
 *  already produced, so old snapshots/hosts are unaffected. */
export const NATIVE_CHAT_NOTICE_KINDS = ['generic', 'login-required'] as const
export type NativeChatNoticeKind = (typeof NATIVE_CHAT_NOTICE_KINDS)[number]

export type NativeChatMessage = {
  /** Stable across re-reads/appends so the assembler and the renderer list can
   *  dedup and key by it. */
  id: string
  role: NativeChatRole
  blocks: NativeChatBlock[]
  /** Epoch ms when the message was produced, or null when the source could not
   *  supply one (e.g. some scrape segments). Null sorts before any timestamp. */
  timestamp: number | null
  source: NativeChatSource
  /** Optional explicit turn key. When present, two messages with the same
   *  `turnId` are treated as the same turn for dedup regardless of `id`. */
  turnId?: string
  /** Set only on a `role: 'system'` message synthesized from a provider
   *  transcript notice (e.g. Claude's `type:"system", subtype:"informational"`
   *  line) that the user should actually see — as opposed to the quiet,
   *  chrome-free system asides the transcript decoders already emit. */
  noticeKind?: NativeChatNoticeKind
}

export const NATIVE_CHAT_TURN_LIFECYCLE_STATES = ['working', 'completed', 'interrupted'] as const
export type NativeChatTurnLifecycleState = (typeof NATIVE_CHAT_TURN_LIFECYCLE_STATES)[number]

export const NATIVE_CHAT_INTERRUPTED_STATUS_TEXT = 'Conversation interrupted'

/** A provider-authored turn boundary recovered from the transcript itself.
 *  Unlike assistant prose, this is explicit lifecycle evidence (completion or
 *  interruption records) and is safe to replay. */
export type NativeChatTurnLifecycle = {
  state: NativeChatTurnLifecycleState
  /** Stable provider id when available, otherwise the JSONL record position. */
  turnId: string
  /** Provider timestamp; null only when the transcript omitted one. */
  timestamp: number | null
}

export const NATIVE_CHAT_SESSION_STATUSES = [
  'loading',
  'ready',
  'working',
  'empty',
  'error'
] as const
export type NativeChatSessionStatus = (typeof NATIVE_CHAT_SESSION_STATUSES)[number]

export type NativeChatSession = {
  messages: NativeChatMessage[]
  status: NativeChatSessionStatus
  /** Provider-owned conversation id once known; null before the agent reports
   *  one (the view shows live hook state and backfills later). */
  sessionId: string | null
  agent: AgentType
  /** Human-readable error when `status === 'error'`. */
  error?: string
}

// ─── Block type guards ──────────────────────────────────────────────────────
// Narrowing helpers so consumers don't repeat `block.type === '…'` string
// literals. Exported for use by the assembler, renderer, and tests.

export function isTextBlock(block: NativeChatBlock): block is NativeChatTextBlock {
  return block.type === 'text'
}

export function isToolCallBlock(block: NativeChatBlock): block is NativeChatToolCallBlock {
  return block.type === 'tool-call'
}

export function isToolResultBlock(block: NativeChatBlock): block is NativeChatToolResultBlock {
  return block.type === 'tool-result'
}

/** The provider-authored interrupt row the transcript decoders emit (Claude's
 *  `interruptedMessageId` record, Codex's `turn_aborted`). The turn it ends
 *  never delivers results for the tool calls it left in flight. */
export function isInterruptedStatusMessage(message: NativeChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.some(
      (block) => block.type === 'text' && block.text === NATIVE_CHAT_INTERRUPTED_STATUS_TEXT
    )
  )
}

export function isImageRefBlock(block: NativeChatBlock): block is NativeChatImageRefBlock {
  return block.type === 'image-ref'
}

/** A provider notice (see `noticeKind`) worth its own banner rather than the
 *  quiet system aside treatment. */
export function isAgentNoticeMessage(message: NativeChatMessage): boolean {
  return message.role === 'system' && message.noticeKind != null
}
