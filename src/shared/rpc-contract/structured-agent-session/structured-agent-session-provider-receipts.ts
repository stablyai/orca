import type { AgentJournalCursor } from '../../agent-session/journal/agent-session-journal-identity'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import * as z from 'zod'

export const PROVIDER_RECEIPT_READ_METHOD = 'agentSession.readProviderReceipts'
export const PROVIDER_RECEIPT_PORT_ACQUIRE = 'runtime:acquireProviderReceiptPort'
export const PROVIDER_RECEIPT_PORT_DELIVERY = 'runtime:providerReceiptPort'
export const PROVIDER_RECEIPT_DISCARD = 'runtime:discardProviderReceipt'
export const MAX_PROVIDER_RECEIPT_REQUEST_BYTES = 512
export const MAX_PROVIDER_RECEIPT_REPLY_BYTES = 229_376
export const MAX_PROVIDER_RECEIPT_REPLY_KEYS = 256

export const ReceiptReader = lazyZodSchema(() =>
  z.object({ id: z.uuid(), generation: z.number().int().nonnegative() }).strict()
)
export const ReceiptCursor = lazyZodSchema(() =>
  z.object({ sequence: z.number().int().positive(), nonce: z.uuid() }).strict()
)
export const ReceiptRead = lazyZodSchema(() =>
  z
    .object({
      reader: ReceiptReader,
      hostIncarnation: z.uuid().nullable(),
      since: ReceiptCursor.nullable(),
      discarded: z.boolean().optional()
    })
    .strict()
)
export const ReceiptPortRequest = lazyZodSchema(() =>
  z.object({ nonce: z.uuid(), reader: ReceiptReader }).strict()
)

export type ProviderReceiptReader = z.infer<typeof ReceiptReader>
export type ProviderReceiptCursor = z.infer<typeof ReceiptCursor>
export type ProviderReceiptRead = z.infer<typeof ReceiptRead>

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
