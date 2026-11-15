import type { NativeChatImageRefBlock } from '../../../../../../shared/native-chat/native-chat-types'
import {
  nativeChatDocumentImages,
  type NativeChatDocumentImage
} from '../../markdown/native-chat-document-images'
import type { NativeChatGallerySurface } from './native-chat-gallery-surfaces'

type GalleryEntryOwner = {
  scopeKey: string
  surfaceId: string
  slotKey: string
  ownerId: string
  role: string
}
type GalleryEntryContent = GalleryEntryOwner &
  (
    | { kind: 'file'; source: string; block: NativeChatImageRefBlock; occurrence: number }
    | ({ kind: 'document' } & NativeChatDocumentImage)
  )
export type NativeChatGalleryEntry = GalleryEntryContent & { key: string }

export function nativeChatGalleryEntryKey(entry: GalleryEntryContent): string {
  if (entry.kind === 'document') {
    return JSON.stringify([
      entry.surfaceId,
      entry.origin,
      entry.source,
      entry.alt,
      entry.linkedHref ?? null
    ])
  }
  return JSON.stringify([
    entry.surfaceId,
    JSON.stringify([entry.source, entry.block.path, entry.block.alt]),
    entry.occurrence
  ])
}

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
    return images.map((image) => {
      const entry = { ...owner, ...image, kind: 'document' as const }
      return { ...entry, key: nativeChatGalleryEntryKey(entry) }
    })
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
    const entry = {
      ...owner,
      kind: 'file' as const,
      source,
      block,
      occurrence
    }
    entries.push({ ...entry, key: nativeChatGalleryEntryKey(entry) })
  }
  return entries
}
