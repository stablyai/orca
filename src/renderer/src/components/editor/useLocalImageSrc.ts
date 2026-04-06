import { useEffect, useState } from 'react'
import { resolveImageAbsolutePath } from './markdown-preview-links'

// Why: the renderer is served from http://localhost in dev mode, so file://
// URLs in <img> tags are blocked by cross-origin restrictions. Loading images
// via the existing fs.readFile IPC and converting to blob URLs bypasses this
// limitation and works identically in both dev and production modes.

const BLOB_URL_CACHE_MAX_SIZE = 100
const blobUrlCache = new Map<string, string>()

// Why: blob URLs hold references to in-memory Blob objects; without eviction
// the cache grows without bound and leaks memory. We evict the oldest entry
// (Map iteration order is insertion order) and revoke its blob URL so the
// browser can free the underlying data.
function cacheBlobUrl(key: string, url: string): void {
  blobUrlCache.set(key, url)
  if (blobUrlCache.size > BLOB_URL_CACHE_MAX_SIZE) {
    const oldest = blobUrlCache.keys().next().value
    if (oldest !== undefined) {
      const oldUrl = blobUrlCache.get(oldest)
      blobUrlCache.delete(oldest)
      if (oldUrl) {
        URL.revokeObjectURL(oldUrl)
      }
    }
  }
}
const cacheListeners = new Set<() => void>()
let cacheGeneration = 0

function base64ToBlobUrl(base64: string, mimeType: string): string {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }))
}

// Why: when the user switches back to the app after deleting or replacing
// image files externally, clearing the cache ensures the preview picks up
// the current filesystem state instead of showing stale in-memory blob URLs.
// Old blob URLs are intentionally NOT revoked so that <img> elements keep
// displaying until the fresh IPC load completes, avoiding a visible flash.
function invalidateImageCache(): void {
  blobUrlCache.clear()
  cacheGeneration += 1
  for (const listener of cacheListeners) {
    listener()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', invalidateImageCache)
}

/**
 * Subscribe to cache invalidation events (fired on window re-focus).
 * Returns an unsubscribe function.
 */
export function onImageCacheInvalidated(listener: () => void): () => void {
  cacheListeners.add(listener)
  return () => {
    cacheListeners.delete(listener)
  }
}

function isExternalUrl(src: string): boolean {
  return (
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('data:') ||
    src.startsWith('blob:')
  )
}

/**
 * Resolves a raw markdown image src to a displayable URL. For local images,
 * reads the file via IPC and returns a blob URL. For http/https/data URLs,
 * returns the URL directly. Re-validates on window re-focus so deleted or
 * replaced images are picked up.
 */
export function useLocalImageSrc(rawSrc: string | undefined, filePath: string): string | undefined {
  const [generation, setGeneration] = useState(cacheGeneration)

  useEffect(() => {
    return onImageCacheInvalidated(() => setGeneration(cacheGeneration))
  }, [])

  const [displaySrc, setDisplaySrc] = useState<string | undefined>(() => {
    if (!rawSrc) {
      return undefined
    }
    if (isExternalUrl(rawSrc)) {
      return rawSrc
    }
    const absolutePath = resolveImageAbsolutePath(rawSrc, filePath)
    if (absolutePath && blobUrlCache.has(absolutePath)) {
      return blobUrlCache.get(absolutePath)
    }
    return undefined
  })

  useEffect(() => {
    if (!rawSrc) {
      setDisplaySrc(undefined)
      return
    }

    if (isExternalUrl(rawSrc)) {
      setDisplaySrc(rawSrc)
      return
    }

    const absolutePath = resolveImageAbsolutePath(rawSrc, filePath)
    if (!absolutePath) {
      setDisplaySrc(rawSrc)
      return
    }

    if (blobUrlCache.has(absolutePath)) {
      setDisplaySrc(blobUrlCache.get(absolutePath))
      return
    }

    let cancelled = false
    window.api.fs
      .readFile({ filePath: absolutePath })
      .then((result) => {
        if (cancelled) {
          return
        }
        if (result.isBinary && result.content) {
          const url = base64ToBlobUrl(result.content, result.mimeType ?? 'image/png')
          cacheBlobUrl(absolutePath, url)
          setDisplaySrc(url)
        } else {
          // Why: if the file exists but is not binary (e.g. an SVG stored as
          // text) or content is empty, fall back to the raw src so the browser
          // can attempt its own loading rather than leaving a broken image.
          setDisplaySrc(rawSrc)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDisplaySrc(rawSrc)
        }
      })

    return () => {
      cancelled = true
    }
  }, [rawSrc, filePath, generation])

  return displaySrc
}

/**
 * Loads a local image via IPC and returns its blob URL, suitable for use
 * outside React (e.g. ProseMirror nodeViews). Resolves from cache when
 * available.
 */
export async function loadLocalImageSrc(rawSrc: string, filePath: string): Promise<string | null> {
  if (
    rawSrc.startsWith('http://') ||
    rawSrc.startsWith('https://') ||
    rawSrc.startsWith('data:') ||
    rawSrc.startsWith('blob:')
  ) {
    return rawSrc
  }

  const absolutePath = resolveImageAbsolutePath(rawSrc, filePath)
  if (!absolutePath) {
    return null
  }

  const cached = blobUrlCache.get(absolutePath)
  if (cached) {
    return cached
  }

  try {
    const result = await window.api.fs.readFile({ filePath: absolutePath })
    if (result.isBinary && result.content) {
      const url = base64ToBlobUrl(result.content, result.mimeType ?? 'image/png')
      cacheBlobUrl(absolutePath, url)
      return url
    }
    // Why: if the file is not binary (e.g. an SVG stored as text) or content
    // is empty, return the raw src so the caller can still display something
    // rather than treating it as a permanent failure.
    return rawSrc
  } catch {
    // Fall through
  }

  return null
}
