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
 *  supersedes an RPC overlay message, which supersedes a hook message, which
 *  supersedes a scrape message. RPC overlay messages are never id-keyed
 *  against the transcript in practice (RPC's in-progress `message` frames
 *  carry no id corresponding to a transcript entry id — verified live against
 *  omp 18.0.6) — the priority still orders them correctly if a future id ever
 *  does correspond, and the rank matters for the overlay-vs-hook-preview case. */
export const NATIVE_CHAT_SOURCES = ['transcript', 'rpc', 'hook', 'scrape'] as const
export type NativeChatSource = (typeof NATIVE_CHAT_SOURCES)[number]

/** Priority rank for a source — higher wins when two sources describe the same
 *  turn. Kept as data so the assembler's precedence is a single lookup, not a
 *  chain of conditionals. */
export const NATIVE_CHAT_SOURCE_PRIORITY: Record<NativeChatSource, number> = {
  transcript: 4,
  rpc: 3,
  hook: 2,
  scrape: 1
}

export const NATIVE_CHAT_ROLES = ['user', 'assistant', 'tool', 'reasoning', 'system'] as const
export type NativeChatRole = (typeof NATIVE_CHAT_ROLES)[number]

/** Plain prose / markdown. The assistant body, a user prompt, reasoning text. */
export type NativeChatTextBlock = {
  type: 'text'
  text: string
  /** Optional structured detail for an otherwise ordinary fallback line. */
  providerFrame?: {
    provider: string
    kind: string
    payload: {
      head: string
      byteLength: number
      digest: string
      truncated: boolean
    }
  }
}

/** A tool invocation by the agent. `input` is the (already-serialized) tool
 *  argument payload; kept as `unknown` because each tool's shape differs and
 *  the renderer only previews it. `toolCallId`, when the source carries one,
 *  identifies the same call across an in-progress overlay and its eventual
 *  transcript entry so a consumer can dedup by identity instead of text. */
export type NativeChatToolCallBlock = {
  type: 'tool-call'
  name: string
  input: unknown
  /** Provider lifecycle when the structured app-server path can supply it. */
  state?: 'running' | 'completed' | 'failed'
  toolCallId?: string
}

/** One resolved hunk from a provider's edit result, carrying true file ranges. */
export type NativeChatEditPatchHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Signed unified rows, as the provider emitted them. */
  lines: string[]
}

/** Hunks the provider resolved against the real file before reporting the edit.
 *  Claude supplies these on its edit results; Codex resolves equivalently before
 *  sending, so its patch already carries ranges and needs no companion. */
export type NativeChatEditPatch = {
  filePath?: string
  hunks: NativeChatEditPatchHunk[]
}

/** The result returned to the agent for a prior tool call. */
export type NativeChatToolResultBlock = {
  type: 'tool-result'
  output: string
  isError?: boolean
  /** Present only for edit tools whose result reported resolved hunks. */
  editPatch?: NativeChatEditPatch
  toolCallId?: string
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
  /** The clock the AGENT put on the message, when a source recovered one.
   *  Distinct from `timestamp`, which for a transcript record is the envelope's
   *  own write time — stamped when the line was persisted, seconds after the
   *  message it wraps. Only this reading is comparable across sources, so it is
   *  what cross-source record identity keys on
   *  (native-chat-rpc-history-merge.ts). Never rendered. */
  originTimestamp?: number
  /** Optional explicit turn key. When present, two messages with the same
   *  `turnId` are treated as the same turn for dedup regardless of `id`. */
  turnId?: string
}

/** The window the runtime RPC applies when a client subscribes without a
 *  `limit` (`nativeChat.readSession` / `nativeChat.subscribeSession`). Shared so
 *  the client bridges grade an omitted-limit read against the window the host
 *  actually used: a runtime too old to send `hasMore` leaves only the exact fill
 *  to infer from (SA-011), and inferring against the wrong window turns a full
 *  page into a false transcript head (SA-014). */
export const NATIVE_CHAT_REMOTE_DEFAULT_WINDOW = 40

/** The widest window the runtime RPC will read, and the widest `limit` a client
 *  may ask for. Shared with the renderer's pagination (XLR-049) because it is a
 *  WIRE constant, not a host implementation detail: runtimes that predate the
 *  host-side clamp validated this same bound with a hard rejection, so a client
 *  that pages past it gets its read refused outright and stalls "load earlier"
 *  at the boundary with the oldest records unreachable. Growing the client's
 *  limit only up to here keeps every request acceptable to both. */
export const NATIVE_CHAT_REMOTE_MAX_WINDOW = 2000

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
