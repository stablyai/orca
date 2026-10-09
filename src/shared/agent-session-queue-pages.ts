import type { AgentSessionQueuedMessagePausedReason } from './agent-session-queued-message-wire'

export const AGENT_SESSION_QUEUE_REPLY_MAX_BYTES = 512 * 1024
export const AGENT_SESSION_QUEUE_SUMMARY_MAX_BYTES = 8 * 1024
export const AGENT_SESSION_QUEUE_PREVIEW_MAX_BYTES = 512
export const AGENT_SESSION_QUEUE_PAGE_MAX_SIZE = 200
export const AGENT_SESSION_QUEUE_PAGE_DEFAULT_SIZE = 40
export const AGENT_SESSION_QUEUE_SOURCES = ['person', 'agent', 'unknown'] as const
export type AgentSessionQueueSource = (typeof AGENT_SESSION_QUEUE_SOURCES)[number]
export function isAgentSessionQueueSource(value: unknown): value is AgentSessionQueueSource {
  return AGENT_SESSION_QUEUE_SOURCES.some((source) => source === value)
}
export type AgentSessionQueueView = 'paged-v1'

export type AgentSessionQueueSummary = {
  generation: string
  revision: number
  total: number
  counts: Record<AgentSessionQueueSource, number>
  newestPersonMessageId: string | null
  blockingReturnedMessageId: string | null
  resumeAvailable: boolean
}

export type AgentSessionQueuedMessagePreview = {
  messageId: string
  position: number
  state: 'waiting' | 'returned'
  paused?: true
  pausedReason?: AgentSessionQueuedMessagePausedReason
  returnedReason?: string | null
  returnedFailure?: { kind: string }
  source: AgentSessionQueueSource
  senderLabels: string[]
  senderCount: number
  preview: string
  truncated: boolean
  bodyBytes: number
}

export type AgentSessionQueuedMessagesPageRequest = {
  sessionId: string
  source?: AgentSessionQueueSource
  cursor?: string
  aroundMessageId?: string
  size?: number
}

export type AgentSessionQueueReset = { status: 'stale'; generation: string; revision: number }
export type AgentSessionQueuedMessagesPageResult =
  | AgentSessionQueueReset
  | {
      status: 'page'
      generation: string
      revision: number
      rows: AgentSessionQueuedMessagePreview[]
      hasMore: { before: boolean; after: boolean }
      previousCursor: string | null
      nextCursor: string | null
    }

export type AgentSessionQueuedMessageReadRequest = {
  sessionId: string
  messageId: string
  expectedState?: 'waiting' | 'returned'
  cursor?: string
}

// Concatenate json in offset order, then JSON.parse once complete; never edit a partial body.
export type AgentSessionQueuedMessageReadResult =
  | AgentSessionQueueReset
  | {
      status: 'body'
      generation: string
      revision: number
      messageId: string
      state: 'waiting' | 'returned'
      bodyBytes: number
      /** Offset in UTF-16 code units of the stored JSON. */
      part: { offset: number; json: string }
      nextCursor: string | null
    }
  | {
      status: 'gone' | 'handed-off' | 'state-changed'
      generation: string
      revision: number
      messageId: string
      state?: string
    }
