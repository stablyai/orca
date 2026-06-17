import type { GlobalSettings } from '../../../shared/types'
import type { RichMarkdownImageSrcResolver } from '@/components/editor/rich-markdown-extensions'
import { trelloDownloadImage } from '@/runtime/runtime-trello-client'

const TRELLO_IMAGE_CACHE_MAX_SIZE = 100
const trelloImageBlobCache = new Map<string, string>()

/**
 * Cache identity: the combination of runtime environment and Trello account that
 * owns a set of blob URLs.  When either changes the cached blobs become
 * meaningless — they were fetched with the old credentials and would fail if
 * re-presented, so they must be revoked and discarded.
 */
export type TrelloImageCacheIdentity = {
  runtimeEnvironmentId?: string | null
  accountId?: string | null
}

function isTrelloDownloadHost(hostname: string): boolean {
  return hostname === 'trello.com' || hostname === 'api.trello.com'
}

function isTrelloAuthenticatedDownload(src: string): boolean {
  try {
    const url = new URL(src)
    return (
      url.protocol === 'https:' &&
      isTrelloDownloadHost(url.hostname) &&
      url.pathname.startsWith('/1/cards/') &&
      url.pathname.includes('/download/')
    )
  } catch {
    return false
  }
}

function cacheTrelloBlobUrl(key: string, url: string): void {
  const previous = trelloImageBlobCache.get(key)
  if (previous) {
    trelloImageBlobCache.delete(key)
    if (previous !== url) {
      URL.revokeObjectURL(previous)
    }
  }
  trelloImageBlobCache.set(key, url)
  if (trelloImageBlobCache.size > TRELLO_IMAGE_CACHE_MAX_SIZE) {
    const oldest = trelloImageBlobCache.keys().next().value
    if (oldest !== undefined) {
      const oldUrl = trelloImageBlobCache.get(oldest)
      trelloImageBlobCache.delete(oldest)
      if (oldUrl) {
        URL.revokeObjectURL(oldUrl)
      }
    }
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

export function createTrelloImageSrcResolver(
  settings: GlobalSettings | null | undefined,
  identity?: TrelloImageCacheIdentity
): RichMarkdownImageSrcResolver {
  const prefix = `${identity?.runtimeEnvironmentId ?? ''}:${identity?.accountId ?? ''}:`

  return async (src) => {
    if (!isTrelloAuthenticatedDownload(src)) {
      return undefined
    }

    const cacheKey = `${prefix}${src}`
    const cached = trelloImageBlobCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const result = await trelloDownloadImage(settings, src)
    console.debug('[trello] Resolving authenticated image through app proxy:', src)
    if (!result.ok) {
      console.warn('[trello] Authenticated image proxy failed:', result.error)
      return null
    }

    // Why: Trello auth stays in main/runtime; the editor only receives an opaque
    // Blob URL, so key/token never enter markdown, DOM attributes, or logs.
    const blobUrl = URL.createObjectURL(
      new Blob([base64ToArrayBuffer(result.contentBase64)], { type: result.contentType })
    )
    cacheTrelloBlobUrl(cacheKey, blobUrl)
    return blobUrl
  }
}

/**
 * Revoke every cached blob URL and clear the entire cache.  Call on Trello
 * disconnect or full cache reset so no stale blobs leak across sessions.
 */
export function clearTrelloImageCache(): void {
  for (const blobUrl of trelloImageBlobCache.values()) {
    URL.revokeObjectURL(blobUrl)
  }
  trelloImageBlobCache.clear()
}

/**
 * Revoke and evict only the cache entries that belong to a specific identity
 * (runtime environment + Trello account).  Used when the user switches accounts
 * or runtimes without disconnecting entirely.
 */
export function clearTrelloImageCacheForIdentity(identity: TrelloImageCacheIdentity): void {
  const prefix = `${identity?.runtimeEnvironmentId ?? ''}:${identity?.accountId ?? ''}:`
  const keysToEvict: string[] = []
  for (const key of trelloImageBlobCache.keys()) {
    if (key.startsWith(prefix)) {
      keysToEvict.push(key)
    }
  }
  for (const key of keysToEvict) {
    const blobUrl = trelloImageBlobCache.get(key)
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl)
    }
    trelloImageBlobCache.delete(key)
  }
}
