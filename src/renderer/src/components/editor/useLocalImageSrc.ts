import { useEffect, useEffectEvent, useState } from 'react'
import { resolveImageAbsolutePath } from './markdown-preview-links'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { readLocalImagePreview } from './local-image-src-reader'
import type { LocalFileAccess } from '../../../../shared/local-file-access'
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
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'

export function getLocalImageCacheKey(
  absolutePath: string,
  connectionId?: string | null,
  runtimeContext?: Omit<RuntimeFileOperationArgs, 'connectionId'> & {
    connectionId?: string | null
  },
  access?: LocalFileAccess
): string {
  const runtimeEnvironmentId = runtimeContext
    ? (runtimeTargetEnvironmentId(runtimeContext.target) ?? 'client')
    : 'client'
  return [
    runtimeEnvironmentId,
    runtimeContext?.connectionId ?? connectionId ?? 'local',
    runtimeContext?.expectedExecutionHostId ?? 'unknown-host',
    runtimeContext?.expectedSshTargetId ?? '',
    runtimeContext?.expectedSshConnectionGeneration?.toString() ?? '',
    runtimeContext?.expectedExternalSshTargetId ?? '',
    runtimeContext?.worktreeId ?? 'unknown-worktree',
    runtimeContext?.worktreePath ?? '',
    // Why: an image read under one access kind must never answer a request made under another.
    access?.kind ?? 'roots',
    access?.kind === 'document-resource' ? access.documentPath : '',
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

type LocalImageRuntimeContext = Omit<RuntimeFileOperationArgs, 'connectionId'> & {
  connectionId?: string | null
}

/** The cache identity of a local image, or null when it is external or has no owner yet. */
export function getLocalImageSrcCacheKey(
  rawSrc: string | undefined,
  filePath: string,
  connectionId?: string | null,
  runtimeContext?: LocalImageRuntimeContext | null,
  access?: LocalFileAccess
): string | null {
  if (!rawSrc || isExternalUrl(rawSrc) || runtimeContext === null) {
    return null
  }
  const absolutePath = resolveImageAbsolutePath(rawSrc, filePath)
  return absolutePath
    ? getLocalImageCacheKey(absolutePath, connectionId, runtimeContext, access)
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
  runtimeContext?: LocalImageRuntimeContext | null,
  access?: LocalFileAccess
): string | undefined {
  const [generation, setGeneration] = useState(getLocalImageCacheGeneration())
  const externalSrc =
    rawSrc && runtimeContext !== null && isExternalUrl(rawSrc) ? rawSrc : undefined
  // Why key effects on the cache key: callers rebuild equal context objects on unrelated store
  // updates, and re-leasing on each one revoked the URL an <img> was still showing.
  const cacheKey = getLocalImageSrcCacheKey(rawSrc, filePath, connectionId, runtimeContext, access)
  const readImage = useEffectEvent((): Promise<string | null> => {
    const absolutePath = rawSrc ? resolveImageAbsolutePath(rawSrc, filePath) : null
    return absolutePath
      ? loadLocalImageAbsolutePath(absolutePath, connectionId, runtimeContext, access)
      : Promise.resolve(null)
  })

  useEffect(() => {
    if (!cacheKey) {
      return
    }
    pinLocalImageCache(cacheKey)
    return () => unpinLocalImageCache(cacheKey)
  }, [cacheKey])

  useEffect(() => {
    return onImageCacheInvalidated(() => setGeneration(getLocalImageCacheGeneration()))
  }, [])

  const [displaySrc, setDisplaySrc] = useState<string | undefined>(
    () => externalSrc ?? (cacheKey ? blobUrlCache.get(cacheKey) : undefined)
  )

  useEffect(() => {
    if (externalSrc || !cacheKey) {
      setDisplaySrc(externalSrc)
      return
    }
    const cached = blobUrlCache.get(cacheKey)
    if (cached) {
      setDisplaySrc(cached)
      return
    }

    let cancelled = false
    const effectGeneration = generation
    readImage()
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
  }, [cacheKey, externalSrc, generation])

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
    | null,
  access?: LocalFileAccess
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

  const cacheKey = getLocalImageCacheKey(absolutePath, connectionId, runtimeContext, access)
  const cached = blobUrlCache.get(cacheKey)
  if (cached) {
    return cached
  }

  return loadLocalImageAbsolutePath(absolutePath, connectionId, runtimeContext, access)
}

export function loadLocalImageAbsolutePath(
  absolutePath: string,
  connectionId?: string | null,
  runtimeContext?:
    | (Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null })
    | null,
  access?: LocalFileAccess
): Promise<string | null> {
  if (runtimeContext === null) {
    return Promise.resolve(null)
  }
  const cacheKey = getLocalImageCacheKey(absolutePath, connectionId, runtimeContext, access)
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
  const loadPromise = readLocalImagePreview(absolutePath, connectionId, runtimeContext, access)
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
  runtimeContext?: LocalImageRuntimeContext | null,
  access?: LocalFileAccess
): (() => void) | undefined {
  const key = getLocalImageSrcCacheKey(rawSrc, filePath, connectionId, runtimeContext, access)
  if (!key) {
    return undefined
  }
  pinLocalImageCache(key)
  return () => unpinLocalImageCache(key)
}

/** Evict the image cached under a `getLocalImageSrcCacheKey` key unless a preview pins it. */
export const releaseLocalImageSrcByKey = releaseLocalImageBlob
