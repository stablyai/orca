import type { NativeChatImageRefBlock } from '../../../../../../shared/native-chat/native-chat-types'
import {
  nativeChatDocumentImages,
  type NativeChatDocumentImage
} from '../../markdown/native-chat-document-images'
import type { NativeChatGallerySurface } from './native-chat-gallery-surfaces'

type GalleryEntryOwner = {
  key: string
  scopeKey: string
  surfaceId: string
  slotKey: string
  ownerId: string
  role: string
}
export type NativeChatGalleryEntry = GalleryEntryOwner &
  (
    | { kind: 'file'; source: string; block: NativeChatImageRefBlock; occurrence: number }
    | ({ kind: 'document' } & NativeChatDocumentImage)
  )

export function nativeChatGallerySurfaceId(
  scopeKey: string,
  surface: NativeChatGallerySurface
): string {
  return JSON.stringify([scopeKey, surface.ownerId, surface.role])
}

export function nativeChatGalleryEntries(
  scopeKey: string,
  surface: NativeChatGallerySurface,
  documentImages?: readonly NativeChatDocumentImage[]
): NativeChatGalleryEntry[] {
  const surfaceId = nativeChatGallerySurfaceId(scopeKey, surface)
  const owner = {
    scopeKey,
    surfaceId,
    ownerId: surface.ownerId,
    slotKey: surface.slotKey,
    role: surface.role
  }
  if (surface.kind === 'document') {
    const images = documentImages ?? nativeChatDocumentImages(surface)
    return images.map((image) => ({
      ...owner,
      ...image,
      kind: 'document',
      key: JSON.stringify([
        surfaceId,
        image.origin,
        image.source,
        image.alt,
        image.linkedHref ?? null
      ])
    }))
  }
  const occurrences = new Map<string, number>()
  const entries: NativeChatGalleryEntry[] = []
  for (const block of surface.blocks) {
    const source = block.url?.trim() || block.path
    if (!source) {
      continue
    }
    const identity = JSON.stringify([source, block.path, block.alt])
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    entries.push({
      ...owner,
      kind: 'file',
      source,
      block,
      occurrence,
      key: JSON.stringify([surfaceId, identity, occurrence])
    })
  }
  return entries
}
