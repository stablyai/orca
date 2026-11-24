import { useEffect, useEffectEvent, useState } from 'react'
import { resolveImageAbsolutePath } from '../markdown/link-routing/markdown-preview-links'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { readLocalImagePreview } from './local-image-src-reader'
import type { LocalFileAccess } from '../../../../../shared/file-access/local-file-access'
import {
  blobUrlCache,
  cacheLocalImageBlob,
  getLocalImageCacheGeneration,
  inFlightBlobUrlLoads,
  isImmutableLocalImageCacheKey,
  unpinLocalImageCache,
  subscribeToLocalImageCacheInvalidation as onImageCacheInvalidated
} from './local-image-src-cache'
import { pinLocalImageCacheKey as pinLocalImageCache } from './local-image-cache-pinning'
import { decodeLocalImageForCache } from './local-image-blob-decode'
import {
  localImageSrcStatus,
  type LocalImageSrcOutcome,
  type LocalImageSrcStatus
} from './local-image-src-status'
import { readBrowserAttachmentFile } from '@/lib/files/drop/browser-attachment-files'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { recordRendererCrashBreadcrumb } from '@/diagnostics/crash-reporting/crash-breadcrumb-recorder'
import { basename } from '@/lib/path'

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
    runtimeContext?.expectedEnvironmentPairingRevision?.toString() ?? '',
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
  if (rawSrc && readBrowserAttachmentFile(rawSrc)) {
    return getLocalImageCacheKey(rawSrc)
  }
  if (!rawSrc || isExternalUrl(rawSrc) || runtimeContext === null) {
    return null
  }
  const absolutePath = resolveImageAbsolutePath(rawSrc, filePath)
  return absolutePath
    ? getLocalImageCacheKey(absolutePath, connectionId, runtimeContext, access)
    : null
}

/** Resolve local images through IPC/blob URLs and revalidate on refocus; external URLs pass through. */
export function useLocalImageSrc(
  rawSrc: string | undefined,
  filePath: string,
  connectionId?: string | null,
  runtimeContext?: LocalImageRuntimeContext | null,
  access?: LocalFileAccess,
  retryKey?: number
): string | undefined {
  return useLocalImageSrcResult(rawSrc, filePath, connectionId, runtimeContext, access, retryKey)
    .src
}

/** `useLocalImageSrc`, plus whether its source belongs to the current read: `src` can still hold the
 *  previous generation's URL, which may already be revoked, while a reread is pending. */
export function useLocalImageSrcResult(
  rawSrc: string | undefined,
  filePath: string,
  connectionId?: string | null,
  runtimeContext?: LocalImageRuntimeContext | null,
  access?: LocalFileAccess,
  retryKey?: number
): { src: string | undefined; status: LocalImageSrcStatus } {
  const [generation, setGeneration] = useState(getLocalImageCacheGeneration())
  const externalSrc =
    rawSrc && runtimeContext !== null && isExternalUrl(rawSrc) ? rawSrc : undefined
  // Key leases by semantic identity; equal rebuilt context objects must not revoke a still-displayed image URL.
  const cacheKey = getLocalImageSrcCacheKey(rawSrc, filePath, connectionId, runtimeContext, access)
  const readImage = useEffectEvent((): Promise<string | null> => {
    if (rawSrc && readBrowserAttachmentFile(rawSrc)) {
      return loadLocalImageAbsolutePath(rawSrc)
    }
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
  const [outcome, setOutcome] = useState<LocalImageSrcOutcome | undefined>(() =>
    !externalSrc && cacheKey && blobUrlCache.has(cacheKey)
      ? { key: cacheKey, generation, found: true }
      : undefined
  )

  useEffect(() => {
    if (externalSrc || !cacheKey) {
      setDisplaySrc(externalSrc)
      return
    }
    const cached = blobUrlCache.get(cacheKey)
    if (cached) {
      setDisplaySrc(cached)
      setOutcome({ key: cacheKey, generation, found: true })
      return
    }

    let cancelled = false
    const effectGeneration = generation
    const settle = (url: string | null): void => {
      const current = getLocalImageCacheGeneration() === effectGeneration
      setDisplaySrc(current && url ? url : undefined)
      // A read from a superseded generation decides nothing; the rerun for the new one does.
      setOutcome({ key: cacheKey, generation: effectGeneration, found: current && Boolean(url) })
    }
    readImage()
      .then((url) => {
        if (!cancelled) {
          settle(url)
        }
      })
      .catch(() => {
        if (!cancelled) {
          settle(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [cacheKey, externalSrc, generation, retryKey])

  const status = localImageSrcStatus({
    external: Boolean(externalSrc),
    cacheKey,
    outcome,
    generation: Math.max(generation, getLocalImageCacheGeneration()),
    owned: Boolean(cacheKey && displaySrc && blobUrlCache.get(cacheKey) === displaySrc)
  })
  return { src: displaySrc, status }
}

/** Load through the same IPC/blob cache outside React, including ProseMirror node views. */
export async function loadLocalImageSrc(
  rawSrc: string,
  filePath: string,
  connectionId?: string | null,
  runtimeContext?:
    | (Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null })
    | null,
  access?: LocalFileAccess
): Promise<string | null> {
  if (readBrowserAttachmentFile(rawSrc)) {
    return loadLocalImageAbsolutePath(rawSrc)
  }
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

const loggedReadFailures = new Set<string>()

/** Why an image read found nothing, once per image, in the main trace log; names the file, never its bytes. */
function logLocalImageReadFailure(
  cacheKey: string,
  absolutePath: string,
  reason: 'not-an-image' | 'read-error',
  error?: unknown
): void {
  if (loggedReadFailures.has(cacheKey)) {
    return
  }
  if (loggedReadFailures.size >= 500) {
    loggedReadFailures.clear()
  }
  loggedReadFailures.add(cacheKey)
  const message = error instanceof Error ? error.message : error === undefined ? '' : String(error)
  const file = basename(absolutePath)
  recordRendererCrashBreadcrumb('local_image_read_failed', {
    file,
    reason,
    ...(message ? { error: message.split(absolutePath).join(file).slice(0, 300) } : {})
  })
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

  const browserFile = readBrowserAttachmentFile(absolutePath)
  if (browserFile) {
    const url = URL.createObjectURL(browserFile)
    return Promise.resolve(cacheLocalImageBlob(cacheKey, url, browserFile.size) ? url : null)
  }

  const inFlight = inFlightBlobUrlLoads.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  const readGeneration = getLocalImageCacheGeneration()
  const superseded = () =>
    getLocalImageCacheGeneration() !== readGeneration && !isImmutableLocalImageCacheKey(cacheKey)
  const loadPromise = readLocalImagePreview(absolutePath, connectionId, runtimeContext, access)
    .then(async (result) => {
      if (superseded()) {
        return null
      }
      if (!result.isBinary || !result.content) {
        logLocalImageReadFailure(cacheKey, absolutePath, 'not-an-image')
        return null
      }
      const blob = await decodeLocalImageForCache(cacheKey, result, superseded)
      if (!blob) {
        return null
      }
      const url = URL.createObjectURL(blob)
      const byteLength = blob.size
      if (superseded()) {
        URL.revokeObjectURL(url)
        return null
      }
      return cacheLocalImageBlob(cacheKey, url, byteLength) ? url : null
    })
    .catch((error: unknown) => {
      logLocalImageReadFailure(cacheKey, absolutePath, 'read-error', error)
      return null
    })
    .finally(() => {
      if (inFlightBlobUrlLoads.get(cacheKey) === loadPromise) {
        inFlightBlobUrlLoads.delete(cacheKey)
      }
    })
  inFlightBlobUrlLoads.set(cacheKey, loadPromise)
  return loadPromise
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
