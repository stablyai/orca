import { NativeChatGalleryEntryIdentities } from './native-chat-gallery-entry-identities'
import {
  nativeChatDocumentImages,
  type NativeChatDocumentImage
} from '../../markdown/native-chat-document-images'
import { yieldToEventLoop } from '../../../../../../shared/concurrency/event-loop-yield'
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
  private readonly groups = new Map<
    number,
    { documents: readonly string[]; identities: readonly string[] }
  >()
  private readonly documentUsers = new Map<string, number>()
  private readonly identities = new NativeChatGalleryEntryIdentities()
  private revision = -1
  private scopeKey = ''
  private order: number[] = []
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
          this.documentUsers.clear()
          this.identities.clear()
        }
        this.scopeKey = request.scopeKey
        this.revision = request.revision
        this.order = []
        this.metrics = this.emptyMetrics()
      } else {
        if (request.revision !== this.revision) {
          return { ...identity, type: 'superseded' }
        }
        if (request.type === 'put') {
          const groups: { handle: number; entries: NativeChatGalleryEntry[] }[] = []
          for (const group of request.groups) {
            if (this.groups.has(group.handle)) {
              throw new Error('Gallery group handle was already uploaded')
            }
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
            const identityKeys = entries.map((entry) => entry.key)
            const identified = entries.map((entry) => this.identities.retain(entry))
            this.groups.set(group.handle, { documents, identities: identityKeys })
            for (const id of documents) {
              this.documentUsers.set(id, (this.documentUsers.get(id) ?? 0) + 1)
            }
            this.appendGroup(group.handle)
            groups.push({ handle: group.handle, entries: identified })
          }
          return { ...identity, type: 'groups', groups }
        }
        if (request.type === 'reuse') {
          for (const handle of request.handles) {
            const group = this.groups.get(handle)
            if (!group) {
              throw new Error('Gallery surface group is no longer available')
            }
            this.metrics.cachedDocuments += group.documents.length
            this.metrics.reusedGroups++
            this.appendGroup(handle)
          }
        } else if (request.type === 'release') {
          for (const handle of request.handles) {
            const group = this.groups.get(handle)
            if (!group) {
              continue
            }
            this.groups.delete(handle)
            this.identities.release(group.identities)
            for (const id of group.documents) {
              const users = (this.documentUsers.get(id) ?? 0) - 1
              if (users <= 0) {
                this.documentUsers.delete(id)
                this.documents.delete(id)
              } else {
                this.documentUsers.set(id, users)
              }
            }
          }
        } else {
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
    this.order.push(handle)
    this.metrics.slots++
  }

  private surfaceEntries(surface: NativeChatGallerySurface): NativeChatGalleryEntry[] {
    let images: readonly NativeChatDocumentImage[] | undefined
    if (surface.kind === 'document') {
      const id = nativeChatGallerySurfaceId(this.scopeKey, surface)
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
