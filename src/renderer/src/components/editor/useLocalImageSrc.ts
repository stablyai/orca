import { useEffect, useState } from 'react'
import { resolveImageAbsolutePath } from './markdown-preview-links'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-client'
import {
  LocalImageBlobRetention,
  MAX_LOCAL_IMAGE_BLOB_BYTES,
  type RetainedLocalImageBlob
} from './local-image-blob-retention'
import { LocalImageLoadAdmission } from './local-image-load-admission'
import { decodeBase64Bytes } from './base64-byte-decoder'
import { assertRasterImagePreviewWithinLimits } from '../../../../shared/raster-image-preview-limits'
import { validateRasterImageDataUri } from '../../../../shared/image-data-uri'

// Why: the renderer is served from http://localhost in dev mode, so file://
// URLs in <img> tags are blocked by cross-origin restrictions. Loading images
// via the existing fs.readFile IPC and converting to blob URLs bypasses this
// limitation and works identically in both dev and production modes.

const blobUrlCache = new LocalImageBlobRetention((url) => URL.revokeObjectURL(url))
const inFlightBlobUrlLoads = new Map<string, Promise<string | null>>()
const imageLoadAdmission = new LocalImageLoadAdmission()

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
function cacheBlobUrl(key: string, entry: RetainedLocalImageBlob): void {
  blobUrlCache.set(key, entry)
}
const cacheListeners = new Set<() => void>()
let cacheGeneration = 0
const pendingBlobUrlRevocations = new Map<string, number>()
let pendingBlobUrlRevocationBytes = 0
let pendingBlobUrlRevocationTimer: ReturnType<typeof setTimeout> | null = null

function base64ToBlobUrl(base64: string, mimeType: string): RetainedLocalImageBlob {
  const bytes = decodeBase64Bytes(base64)
  assertRasterImagePreviewWithinLimits(bytes, mimeType)
  return { url: URL.createObjectURL(new Blob([bytes], { type: mimeType })), bytes: bytes.length }
}

function revokePendingBlobUrls(): void {
  pendingBlobUrlRevocationTimer = null
  for (const url of pendingBlobUrlRevocations.keys()) {
    URL.revokeObjectURL(url)
  }
  pendingBlobUrlRevocations.clear()
  pendingBlobUrlRevocationBytes = 0
}

function scheduleBlobUrlRevocation(entries: RetainedLocalImageBlob[]): void {
  for (const { url, bytes } of entries) {
    const previousBytes = pendingBlobUrlRevocations.get(url) ?? 0
    pendingBlobUrlRevocations.set(url, bytes)
    pendingBlobUrlRevocationBytes += bytes - previousBytes
  }
  while (pendingBlobUrlRevocationBytes > MAX_LOCAL_IMAGE_BLOB_BYTES) {
    const oldest = pendingBlobUrlRevocations.entries().next().value
    if (!oldest) {
      break
    }
    const [url, bytes] = oldest
    pendingBlobUrlRevocations.delete(url)
    pendingBlobUrlRevocationBytes -= bytes
    URL.revokeObjectURL(url)
  }
  if (pendingBlobUrlRevocationTimer !== null || pendingBlobUrlRevocations.size === 0) {
    return
  }
  pendingBlobUrlRevocationTimer = setTimeout(revokePendingBlobUrls, 30_000)
}

// Why: when the user switches back to the app after deleting or replacing
// image files externally, clearing the cache forces the preview to pick up
// the current filesystem state instead of showing stale in-memory blob URLs.
// Old blob URLs are revoked after a short delay so that <img> elements still
// display the old data while the fresh IPC load completes, avoiding a visible
// flash. The 30-second window is generous enough for even slow IPC reads.
function invalidateImageCache(): void {
  const staleUrls = blobUrlCache.clear()
  inFlightBlobUrlLoads.clear()
  imageLoadAdmission.clearPending()
  cacheGeneration += 1
  for (const listener of cacheListeners) {
    listener()
  }
  // Why: defer revocation so the browser keeps the old blob data readable
  // until replacement IPC loads complete, then free the underlying memory.
  // 30 seconds is generous enough to cover slow machines or large images
  // without risking a visible broken-image flash.
  if (staleUrls.length > 0) {
    scheduleBlobUrlRevocation(staleUrls)
  }
}

function disposeImageCacheModuleState(): void {
  cacheGeneration += 1
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', invalidateImageCache)
  }
  if (pendingBlobUrlRevocationTimer !== null) {
    clearTimeout(pendingBlobUrlRevocationTimer)
    pendingBlobUrlRevocationTimer = null
  }
  revokePendingBlobUrls()
  for (const { url } of blobUrlCache.clear()) {
    URL.revokeObjectURL(url)
  }
  imageLoadAdmission.clearPending()
  inFlightBlobUrlLoads.clear()
  cacheListeners.clear()
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', invalidateImageCache)
}

if (typeof import.meta !== 'undefined' && import.meta.hot) {
  // Why: Vite can re-evaluate this module without a full renderer reload.
  // Disposing the module-level listener and blob URLs prevents dev-session leaks.
  import.meta.hot.dispose(disposeImageCacheModuleState)
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

function resolveExternalImageUrl(src: string): string | null {
  if (src.startsWith('data:')) {
    return validateRasterImageDataUri(src)
  }
  return src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:')
    ? src
    : null
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
    const externalSrc = resolveExternalImageUrl(rawSrc)
    if (externalSrc) {
      return externalSrc
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

    const externalSrc = resolveExternalImageUrl(rawSrc)
    if (externalSrc) {
      setDisplaySrc(externalSrc)
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
    const effectGeneration = generation
    loadLocalImageAbsolutePath(absolutePath, connectionId, runtimeContext)
      .then((url) => {
        if (cancelled) {
          return
        }
        setDisplaySrc(cacheGeneration === effectGeneration && url ? url : undefined)
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
  const externalSrc = resolveExternalImageUrl(rawSrc)
  if (externalSrc) {
    return externalSrc
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

  return loadLocalImageAbsolutePath(absolutePath, connectionId, runtimeContext)
}

export function loadLocalImageAbsolutePath(
  absolutePath: string,
  connectionId?: string | null,
  runtimeContext?: Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null }
): Promise<string | null> {
  const cacheKey = getLocalImageCacheKey(absolutePath, connectionId, runtimeContext)
  const cached = blobUrlCache.get(cacheKey)
  if (cached) {
    return Promise.resolve(cached)
  }

  const inFlight = inFlightBlobUrlLoads.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  const readGeneration = cacheGeneration
  const admitted = imageLoadAdmission.admit(() =>
    readImagePreview(absolutePath, connectionId, runtimeContext)
  )
  if (!admitted) {
    return Promise.resolve(null)
  }
  const loadPromise = admitted
    .then((result) => {
      if (!result?.isBinary || !result.content || cacheGeneration !== readGeneration) {
        // Why: local image paths must stay behind IPC/runtime authorization;
        // handing raw file: or relative paths back to Chromium can escape it.
        return null
      }
      const entry = base64ToBlobUrl(result.content, result.mimeType ?? 'image/png')
      if (cacheGeneration !== readGeneration) {
        URL.revokeObjectURL(entry.url)
        return null
      }
      cacheBlobUrl(cacheKey, entry)
      return entry.url
    })
    .catch(() => null)
    .finally(() => {
      if (inFlightBlobUrlLoads.get(cacheKey) === loadPromise) {
        inFlightBlobUrlLoads.delete(cacheKey)
      }
    })
  inFlightBlobUrlLoads.set(cacheKey, loadPromise)
  return loadPromise
}

export function resetLocalImageSrcStateForTests(): void {
  if (pendingBlobUrlRevocationTimer !== null) {
    clearTimeout(pendingBlobUrlRevocationTimer)
    pendingBlobUrlRevocationTimer = null
  }
  revokePendingBlobUrls()
  for (const { url } of blobUrlCache.clear()) {
    URL.revokeObjectURL(url)
  }
  imageLoadAdmission.clearPending()
  inFlightBlobUrlLoads.clear()
  cacheGeneration += 1
  pendingBlobUrlRevocations.clear()
  pendingBlobUrlRevocationBytes = 0
  cacheListeners.clear()
}

export function invalidateLocalImageSrcCacheForTests(): void {
  invalidateImageCache()
}

function readImagePreview(
  absolutePath: string,
  connectionId?: string | null,
  runtimeContext?: Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null }
) {
  try {
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
  } catch (error) {
    return Promise.reject(error)
  }
}
