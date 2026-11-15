import type { NativeChatGalleryEntry } from './native-chat-gallery-entries'
import type { NativeChatGallerySurface } from './native-chat-gallery-surfaces'
import type { NativeChatGalleryWireToken } from './native-chat-gallery-transfer'

export type NativeChatGalleryWorkerCommand =
  | { type: 'begin'; scopeKey: string }
  | {
      type: 'put'
      groups: readonly {
        handle: number
        surfaces: readonly NativeChatGallerySurface[]
        projectionMs: number
      }[]
    }
  | { type: 'reuse'; handles: readonly number[] }
  | { type: 'release'; handles: readonly number[] }
  | { type: 'commit' }

export type NativeChatGalleryWorkerRequest = {
  id: number
  revision: number
} & NativeChatGalleryWorkerCommand

export type NativeChatGalleryIndexMetrics = {
  projectionMs: number
  parseMs: number
  slots: number
  sourceCharacters: number
  cachedDocuments: number
  reusedGroups: number
}

export type NativeChatGalleryWorkerResult = { id: number; revision: number } & (
  | { type: 'ack' }
  | { type: 'superseded' }
  | { type: 'groups'; groups: { handle: number; entries: NativeChatGalleryEntry[] }[] }
  | { type: 'ready'; order: number[]; metrics: NativeChatGalleryIndexMetrics }
  | { type: 'error'; message: string }
)

export type NativeChatGalleryWireRequest = { id: number; revision: number } & (
  | { type: 'push'; tokens: NativeChatGalleryWireToken[]; last: boolean }
  | { type: 'pull' }
)
export type NativeChatGalleryWireResult = { id: number; revision: number } & (
  | { type: 'ack' | 'failed' }
  | { type: 'data'; tokens: NativeChatGalleryWireToken[]; last: boolean }
)
