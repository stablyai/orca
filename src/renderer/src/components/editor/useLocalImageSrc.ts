import { useEffect, useState } from 'react'
import { resolveImageAbsolutePath } from './markdown-preview-links'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-client'

// Why: the renderer is served from http://localhost in dev mode, so file://
// URLs in <img> tags are blocked by cross-origin restrictions. Loading images
// via the existing fs.readFile IPC and converting to blob URLs bypasses this
// limitation and works identically in both dev and production modes.

const BLOB_URL_CACHE_MAX_SIZE = 100
const blobUrlCache = new Map<string, string>()

export function getLocalImageCacheKey(
  absolutePath: string,
  connectionId?: string | null,
  runtimeContext?: Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null }
): string {
  const runtimeEnvironmentId =
    runtimeContext?.settings?.activeRuntimeEnvironmentId?.trim() ?? 'client'
  return [
    runtimeEnvironmentId,
    runtimeContext?.connectionId ?? connectionId ?? 'local',
    runtimeContext?.worktreeId ?? 'unknown-worktree',
    absolutePath
  ].join('\0')
}

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
// image files externally, clearing the cache forces the preview to pick up
// the current filesystem state instead of showing stale in-memory blob URLs.
// Old blob URLs are revoked after a short delay so that <img> elements still
// display the old data while the fresh IPC load completes, avoiding a visible
// flash. The 5-second window is generous enough for even slow IPC reads.
function invalidateImageCache(): void {
  const staleUrls = Array.from(blobUrlCache.values())
  blobUrlCache.clear()
  cacheGeneration += 1
  for (const listener of cacheListeners) {
    listener()
  }
  // Why: defer revocation so the browser keeps the old blob data readable
  // until replacement IPC loads complete, then free the underlying memory.
  // 30 seconds is generous enough to cover slow machines or large images
  // without risking a visible broken-image flash.
  if (staleUrls.length > 0) {
    setTimeout(() => {
      for (const url of staleUrls) {
        URL.revokeObjectURL(url)
      }
    }, 30_000)
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
export function useLocalImageSrc(
  rawSrc: string | undefined,
  filePath: string,
  connectionId?: string | null,
  runtimeContext?: Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null }
): string | undefined {
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
    if (absolutePath) {
      const cacheKey = getLocalImageCacheKey(absolutePath, connectionId, runtimeContext)
      if (blobUrlCache.has(cacheKey)) {
        return blobUrlCache.get(cacheKey)
      }
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
      setDisplaySrc(undefined)
      return
    }

    const cacheKey = getLocalImageCacheKey(absolutePath, connectionId, runtimeContext)
    if (blobUrlCache.has(cacheKey)) {
      setDisplaySrc(blobUrlCache.get(cacheKey))
      return
    }

    let cancelled = false
    readImagePreview(absolutePath, connectionId, runtimeContext)
      .then((result) => {
        if (cancelled) {
          return
        }
        if (result.isBinary && result.content) {
          const url = base64ToBlobUrl(result.content, result.mimeType ?? 'image/png')
          cacheBlobUrl(cacheKey, url)
          setDisplaySrc(url)
        } else {
          // Why: local image paths must stay behind IPC/runtime authorization;
          // handing raw file: or relative paths back to Chromium can escape it.
          setDisplaySrc(undefined)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDisplaySrc(undefined)
        }
      })

    return () => {
      cancelled = true
    }
  }, [rawSrc, filePath, generation, connectionId, runtimeContext])

  return displaySrc
}

/**
 * Loads a local image via IPC and returns its blob URL, suitable for use
 * outside React (e.g. ProseMirror nodeViews). Resolves from cache when
 * available.
 */
export async function loadLocalImageSrc(
  rawSrc: string,
  filePath: string,
  connectionId?: string | null,
  runtimeContext?: Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null }
): Promise<string | null> {
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

  const cacheKey = getLocalImageCacheKey(absolutePath, connectionId, runtimeContext)
  const cached = blobUrlCache.get(cacheKey)
  if (cached) {
    return cached
  }

  try {
    const result = await readImagePreview(absolutePath, connectionId, runtimeContext)
    if (result.isBinary && result.content) {
      const url = base64ToBlobUrl(result.content, result.mimeType ?? 'image/png')
      cacheBlobUrl(cacheKey, url)
      return url
    }
    // Why: local image paths must stay behind IPC/runtime authorization;
    // callers should render a missing image instead of falling back to raw src.
    return null
  } catch {
    // Fall through
  }

  return null
}

function readImagePreview(
  absolutePath: string,
  connectionId?: string | null,
  runtimeContext?: Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null }
) {
  if (!runtimeContext) {
    return window.api.fs.readFile({
      filePath: absolutePath,
      connectionId: connectionId ?? undefined
    })
  }
  return readRuntimeFilePreview(
    {
      ...runtimeContext,
      connectionId: runtimeContext.connectionId ?? connectionId ?? undefined
    },
    absolutePath
  )
}
