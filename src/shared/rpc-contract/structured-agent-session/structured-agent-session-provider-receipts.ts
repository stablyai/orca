import type { AgentJournalCursor } from '../../agent-session/journal/agent-session-journal-identity'

export const PROVIDER_RECEIPT_READ_METHOD = 'agentSession.readProviderReceipts'
export const MAX_PROVIDER_RECEIPT_REPLY_BYTES = 229_376
export const MAX_PROVIDER_RECEIPT_REPLY_KEYS = 256

export type ProviderReceiptReader = { id: string; generation: number }
export type ProviderReceiptCursor = { sequence: number; nonce: string }
export type ProviderReceiptRead = {
  reader: ProviderReceiptReader
  hostIncarnation: string | null
  since: ProviderReceiptCursor | null
  discarded?: boolean
}

export type ProviderReceiptUpdate = {
  clientMessageId: string
  attempt: number
  handoverSequence: number
  fence: number
  observedAt: number | null
}

export type ProviderReceiptStreamUpdate = {
  subscription: string
  generation: number
  sessionId: string
  epoch: string
  throughCursor: AgentJournalCursor
  reset: { id: string; offset: number; complete: boolean } | null
  updates: ProviderReceiptUpdate[]
}

export type ProviderReceiptStatus =
  | 'changed'
  | 'reader_unknown'
  | 'superseded'
  | 'capacity'
  | 'detached'
  | 'host_restarted'
  | 'closed'

export type ProviderReceiptReply = {
  status: ProviderReceiptStatus
  hostIncarnation: string
  revision: ProviderReceiptCursor
  streams: ProviderReceiptStreamUpdate[]
}
