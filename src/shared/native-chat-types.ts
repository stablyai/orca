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

export function isImageRefBlock(block: NativeChatBlock): block is NativeChatImageRefBlock {
  return block.type === 'image-ref'
}
