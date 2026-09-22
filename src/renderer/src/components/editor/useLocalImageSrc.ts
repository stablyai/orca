import { useEffect, useState } from 'react'
import { resolveImageAbsolutePath } from './markdown-preview-links'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { readLocalImagePreview } from './local-image-src-reader'
import {
  blobUrlCache,
  cacheLocalImageBlob,
  cleanupLocalImageCacheKeyVersion,
  getLocalImageCacheGeneration,
  getLocalImageCacheKeyVersion,
  inFlightBlobUrlLoads,
  invalidateLocalImageCache,
  pinLocalImageCache,
  releaseLocalImageBlob,
  resetLocalImageCacheState,
  subscribeToLocalImageCacheInvalidation,
  unpinLocalImageCache
} from './local-image-src-cache'

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
    runtimeContext?.expectedExecutionHostId ?? 'unknown-host',
    runtimeContext?.expectedSshTargetId ?? '',
    runtimeContext?.expectedSshConnectionGeneration?.toString() ?? '',
    runtimeContext?.expectedExternalSshTargetId ?? '',
    runtimeContext?.worktreeId ?? 'unknown-worktree',
    runtimeContext?.worktreePath ?? '',
    absolutePath
  ].join('\0')
}

function base64ToBlobUrl(base64: string, mimeType: string): { url: string; byteLength: number } {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return {
    url: URL.createObjectURL(new Blob([bytes], { type: mimeType })),
    byteLength: bytes.byteLength
  }
}

export const onImageCacheInvalidated = subscribeToLocalImageCacheInvalidation

function isExternalUrl(src: string): boolean {
  return /^(?:https?|data|blob):/i.test(src)
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
  runtimeContext?:
    | (Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null })
    | null
): string | undefined {
  const [generation, setGeneration] = useState(getLocalImageCacheGeneration())

  useEffect(() => {
    return acquireLocalImageSrcLease(rawSrc, filePath, connectionId, runtimeContext)
  }, [rawSrc, filePath, connectionId, runtimeContext])

  useEffect(() => {
    return onImageCacheInvalidated(() => setGeneration(getLocalImageCacheGeneration()))
  }, [])

  const [displaySrc, setDisplaySrc] = useState<string | undefined>(() => {
    if (!rawSrc || runtimeContext === null) {
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
    if (!rawSrc || runtimeContext === null) {
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
    const effectGeneration = generation
    loadLocalImageAbsolutePath(absolutePath, connectionId, runtimeContext)
      .then((url) => {
        if (cancelled) {
          return
        }
        setDisplaySrc(getLocalImageCacheGeneration() === effectGeneration && url ? url : undefined)
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
  runtimeContext?:
    | (Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null })
    | null
): Promise<string | null> {
  if (isExternalUrl(rawSrc)) {
    return rawSrc
  }
  if (runtimeContext === null) {
    return null
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
  runtimeContext?:
    | (Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null })
    | null
): Promise<string | null> {
  if (runtimeContext === null) {
    return Promise.resolve(null)
  }
  const cacheKey = getLocalImageCacheKey(absolutePath, connectionId, runtimeContext)
  const cached = blobUrlCache.get(cacheKey)
  if (cached) {
    return Promise.resolve(cached)
  }

  const inFlight = inFlightBlobUrlLoads.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  const readGeneration = getLocalImageCacheGeneration()
  const readLeaseVersion = getLocalImageCacheKeyVersion(cacheKey)
  const loadPromise = readLocalImagePreview(absolutePath, connectionId, runtimeContext)
    .then((result) => {
      if (
        !result.isBinary ||
        !result.content ||
        getLocalImageCacheGeneration() !== readGeneration
      ) {
        return null
      }
      const { url, byteLength } = base64ToBlobUrl(result.content, result.mimeType ?? 'image/png')
      if (getLocalImageCacheGeneration() !== readGeneration) {
        URL.revokeObjectURL(url)
        return null
      }
      return cacheLocalImageBlob(cacheKey, url, byteLength, readLeaseVersion) ? url : null
    })
    .catch(() => null)
    .finally(() => {
      if (inFlightBlobUrlLoads.get(cacheKey) === loadPromise) {
        inFlightBlobUrlLoads.delete(cacheKey)
      }
      cleanupLocalImageCacheKeyVersion(cacheKey)
    })
  inFlightBlobUrlLoads.set(cacheKey, loadPromise)
  return loadPromise
}

export function resetLocalImageSrcStateForTests(): void {
  resetLocalImageCacheState()
}

export function invalidateLocalImageSrcCacheForTests(): void {
  invalidateLocalImageCache()
}

export function acquireLocalImageSrcLease(
  rawSrc: string | undefined,
  filePath: string,
  connectionId?: string | null,
  runtimeContext?:
    | (Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null })
    | null
): (() => void) | undefined {
  if (!rawSrc || isExternalUrl(rawSrc) || runtimeContext === null) {
    return undefined
  }
  const absolutePath = resolveImageAbsolutePath(rawSrc, filePath)
  if (!absolutePath) {
    return undefined
  }
  const key = getLocalImageCacheKey(absolutePath, connectionId, runtimeContext)
  pinLocalImageCache(key)
  return () => unpinLocalImageCache(key)
}

/** Evict one no-longer-visible transcript preview immediately. */
export function releaseLocalImageSrc(
  rawSrc: string,
  filePath: string,
  connectionId?: string | null,
  runtimeContext?:
    | (Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null })
    | null
): void {
  if (!rawSrc || isExternalUrl(rawSrc) || runtimeContext === null) {
    return
  }
  const absolutePath = resolveImageAbsolutePath(rawSrc, filePath)
  if (!absolutePath) {
    return
  }
  const key = getLocalImageCacheKey(absolutePath, connectionId, runtimeContext)
  releaseLocalImageBlob(key)
}
