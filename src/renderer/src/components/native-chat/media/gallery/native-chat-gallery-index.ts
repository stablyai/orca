import {
  nativeChatDocumentImages,
  type NativeChatDocumentImage
} from '../../markdown/native-chat-document-images'
import { yieldToEventLoop } from '../../../../../../shared/event-loop-yield'
import {
  nativeChatGallerySlotSurfaces,
  nativeChatReasoningImageSurface,
  type NativeChatGallerySurface
} from './native-chat-gallery-surfaces'
import {
  nativeChatGalleryEntries,
  nativeChatGallerySurfaceId,
  type NativeChatGalleryEntry
} from './native-chat-gallery-entries'
import type {
  NativeChatGalleryIndexMetrics,
  NativeChatGalleryWorkerRequest,
  NativeChatGalleryWorkerResult
} from './native-chat-gallery-worker-protocol'

type DocumentCache = {
  text: string
  growing: boolean
  visuals: boolean
  images: readonly NativeChatDocumentImage[]
}

export class NativeChatGalleryIndex {
  private readonly documents = new Map<string, DocumentCache>()
  private revision = -1
  private scopeKey = ''
  private options = { stoppedLabel: '', visuals: false }
  private entries: NativeChatGalleryEntry[] = []
  private readonly seenDocuments = new Set<string>()
  private readonly seenEntries = new Set<string>()
  private metrics: NativeChatGalleryIndexMetrics = this.emptyMetrics()

  private emptyMetrics(): NativeChatGalleryIndexMetrics {
    return { projectionMs: 0, parseMs: 0, slots: 0, sourceCharacters: 0, cachedDocuments: 0 }
  }

  async handle(request: NativeChatGalleryWorkerRequest): Promise<NativeChatGalleryWorkerResult> {
    const identity = { id: request.id, revision: request.revision }
    try {
      if (request.type === 'begin') {
        if (this.scopeKey !== request.scopeKey) {
          this.documents.clear()
        }
        this.scopeKey = request.scopeKey
        this.revision = request.revision
        this.options = { stoppedLabel: request.stoppedLabel, visuals: request.visuals }
        this.entries = []
        this.seenDocuments.clear()
        this.seenEntries.clear()
        this.metrics = this.emptyMetrics()
      } else {
        if (request.revision !== this.revision) {
          return { ...identity, type: 'superseded' }
        }
        if (request.type === 'slot') {
          const started = performance.now()
          const surfaces = nativeChatGallerySlotSurfaces(request.slot, this.options)
          this.metrics.projectionMs += performance.now() - started
          let processedSurface = false
          for (const surface of surfaces) {
            if (
              surface.kind === 'files' ? surface.blocks.length === 0 : surface.text.length === 0
            ) {
              continue
            }
            if (processedSurface) {
              await yieldToEventLoop()
            }
            if (request.revision !== this.revision) {
              return { ...identity, type: 'superseded' }
            }
            this.appendSurface(surface)
            processedSurface = true
          }
          this.metrics.slots++
        } else if (request.type === 'reasoning') {
          this.appendSurface(
            nativeChatReasoningImageSurface(request.message, request.message.id, request.growing)
          )
        } else {
          for (const id of this.documents.keys()) {
            if (!this.seenDocuments.has(id)) {
              this.documents.delete(id)
            }
          }
          return { ...identity, type: 'ready', entries: this.entries, metrics: this.metrics }
        }
      }
      return { ...identity, type: 'ack', completedSlots: this.metrics.slots }
    } catch (error) {
      this.revision = -1
      this.entries = []
      return {
        ...identity,
        type: 'error',
        message: error instanceof Error ? error.message : 'Unable to index chat images'
      }
    }
  }

  private appendSurface(surface: NativeChatGallerySurface): void {
    let images: readonly NativeChatDocumentImage[] | undefined
    if (surface.kind === 'document') {
      const id = nativeChatGallerySurfaceId(this.scopeKey, surface)
      this.seenDocuments.add(id)
      const cached = this.documents.get(id)
      if (
        cached?.text === surface.text &&
        cached.growing === surface.growing &&
        cached.visuals === surface.visuals
      ) {
        images = cached.images
        this.metrics.cachedDocuments++
      } else {
        const started = performance.now()
        images = surface.text ? nativeChatDocumentImages(surface) : []
        this.metrics.parseMs += performance.now() - started
        this.metrics.sourceCharacters += surface.text.length
        this.documents.set(id, { ...surface, images })
      }
    }
    for (const entry of nativeChatGalleryEntries(this.scopeKey, surface, images)) {
      if (this.seenEntries.has(entry.key)) {
        continue
      }
      this.seenEntries.add(entry.key)
      this.entries.push(entry)
    }
  }
}
