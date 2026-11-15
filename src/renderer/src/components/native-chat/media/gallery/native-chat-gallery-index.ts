import {
  nativeChatDocumentImages,
  type NativeChatDocumentImage
} from '../../markdown/native-chat-document-images'
import { yieldToEventLoop } from '../../../../../../shared/event-loop-yield'
import type { NativeChatGallerySurface } from './native-chat-gallery-surfaces'
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
  private readonly groups = new Map<number, readonly string[]>()
  private revision = -1
  private scopeKey = ''
  private order: number[] = []
  private readonly seenDocuments = new Set<string>()
  private readonly seenGroups = new Set<number>()
  private metrics: NativeChatGalleryIndexMetrics = this.emptyMetrics()

  private emptyMetrics(): NativeChatGalleryIndexMetrics {
    return {
      projectionMs: 0,
      parseMs: 0,
      slots: 0,
      sourceCharacters: 0,
      cachedDocuments: 0,
      reusedGroups: 0
    }
  }

  async handle(request: NativeChatGalleryWorkerRequest): Promise<NativeChatGalleryWorkerResult> {
    const identity = { id: request.id, revision: request.revision }
    try {
      if (request.type === 'begin') {
        if (this.scopeKey !== request.scopeKey) {
          this.documents.clear()
          this.groups.clear()
        }
        this.scopeKey = request.scopeKey
        this.revision = request.revision
        this.order = []
        this.seenDocuments.clear()
        this.seenGroups.clear()
        this.metrics = this.emptyMetrics()
      } else {
        if (request.revision !== this.revision) {
          return { ...identity, type: 'superseded' }
        }
        if (request.type === 'put') {
          const groups: { handle: number; entries: NativeChatGalleryEntry[] }[] = []
          for (const group of request.groups) {
            const entries: NativeChatGalleryEntry[] = []
            const documents: string[] = []
            this.metrics.projectionMs += group.projectionMs
            let processedSurface = false
            for (const surface of group.surfaces) {
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
              if (surface.kind === 'document') {
                documents.push(nativeChatGallerySurfaceId(this.scopeKey, surface))
              }
              for (const entry of this.surfaceEntries(surface)) {
                entries.push(entry)
              }
              processedSurface = true
            }
            this.groups.set(group.handle, documents)
            this.appendGroup(group.handle)
            groups.push({ handle: group.handle, entries })
          }
          return { ...identity, type: 'groups', groups }
        }
        if (request.type === 'reuse') {
          for (const handle of request.handles) {
            const documents = this.groups.get(handle)
            if (!documents) {
              throw new Error('Gallery surface group is no longer available')
            }
            for (const id of documents) {
              this.seenDocuments.add(id)
            }
            this.metrics.cachedDocuments += documents.length
            this.metrics.reusedGroups++
            this.appendGroup(handle)
          }
        } else {
          for (const id of this.documents.keys()) {
            if (!this.seenDocuments.has(id)) {
              this.documents.delete(id)
            }
          }
          for (const handle of this.groups.keys()) {
            if (!this.seenGroups.has(handle)) {
              this.groups.delete(handle)
            }
          }
          return { ...identity, type: 'ready', order: this.order, metrics: this.metrics }
        }
      }
      return { ...identity, type: 'ack' }
    } catch (error) {
      this.revision = -1
      this.order = []
      return {
        ...identity,
        type: 'error',
        message: error instanceof Error ? error.message : 'Unable to index chat images'
      }
    }
  }

  private appendGroup(handle: number): void {
    this.seenGroups.add(handle)
    this.order.push(handle)
    this.metrics.slots++
  }

  private surfaceEntries(surface: NativeChatGallerySurface): NativeChatGalleryEntry[] {
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
        this.documents.set(id, {
          text: surface.text,
          growing: surface.growing,
          visuals: surface.visuals,
          images
        })
      }
    }
    return nativeChatGalleryEntries(this.scopeKey, surface, images)
  }
}
