import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatGalleryEntry } from './native-chat-gallery-entries'
import type { NativeChatGallerySlot } from './native-chat-gallery-surfaces'

export type NativeChatGalleryWorkerRequest = { id: number; revision: number } & (
  | { type: 'begin'; scopeKey: string; stoppedLabel: string; visuals: boolean }
  | { type: 'slot'; slot: NativeChatGallerySlot }
  | { type: 'reasoning'; message: Pick<NativeChatMessage, 'id' | 'blocks'>; growing: boolean }
  | { type: 'commit' }
)

export type NativeChatGalleryIndexMetrics = {
  projectionMs: number
  parseMs: number
  slots: number
  sourceCharacters: number
  cachedDocuments: number
}

export type NativeChatGalleryWorkerResult = { id: number; revision: number } & (
  | { type: 'ack'; completedSlots: number }
  | { type: 'superseded' }
  | {
      type: 'ready'
      entries: NativeChatGalleryEntry[]
      metrics: NativeChatGalleryIndexMetrics
    }
  | { type: 'error'; message: string }
)
