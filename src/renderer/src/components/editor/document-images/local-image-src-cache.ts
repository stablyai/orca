import {
  clearLocalImageCachePins,
  isLocalImageCacheKeyPinned,
  prunePinnedLocalImageCache,
  unpinLocalImageCacheKey
} from './local-image-cache-pinning'
import { isCommittedAgentSessionAttachmentPath } from '../../../../../shared/agent-session/agent-session-attachments'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { IMAGE_AND_PDF_PREVIEW_MIME_TYPES } from '../../../../../shared/file-preview/file-preview-kind'

const BLOB_URL_CACHE_MAX_SIZE = 100
// Bound retained encoded image payload separately from the reusable entry target.
const BLOB_URL_CACHE_MAX_BYTES = 128 * 1024 * 1024

export const blobUrlCache = new Map<string, string>()
const blobUrlCacheBytes = new Map<string, number>()
export const inFlightBlobUrlLoads = new Map<string, Promise<string | null>>()

let cacheGeneration = 0
const cacheListeners = new Set<() => void>()
const pendingBlobUrlRevocations = new Set<string>()
let pendingBlobUrlRevocationTimer: ReturnType<typeof setTimeout> | null = null

function pruneImageCache(): void {
  prunePinnedLocalImageCache(blobUrlCache, BLOB_URL_CACHE_MAX_SIZE, (url) => {
    URL.revokeObjectURL(url)
  })
  for (const key of blobUrlCacheBytes.keys()) {
    if (!blobUrlCache.has(key)) {
      blobUrlCacheBytes.delete(key)
    }
  }
  let retainedBytes = 0
  for (const byteLength of blobUrlCacheBytes.values()) {
    retainedBytes += byteLength
  }
  while (retainedBytes > BLOB_URL_CACHE_MAX_BYTES) {
    const key = Array.from(blobUrlCache.keys()).find(
      (candidate) => !isLocalImageCacheKeyPinned(candidate)
    )
    if (key === undefined) {
      return
    }
    const url = blobUrlCache.get(key)
    blobUrlCache.delete(key)
    retainedBytes -= blobUrlCacheBytes.get(key) ?? 0
    blobUrlCacheBytes.delete(key)
    if (url) {
      URL.revokeObjectURL(url)
    }
  }
}

/** Whether `cacheLocalImageBlob` would admit this many bytes now, evicting every unpinned entry if it
 *  had to: lets a reader refuse a photo-sized payload before spending time decoding it. */
export function localImageBlobFits(key: string, byteLength: number): boolean {
  if (byteLength > BLOB_URL_CACHE_MAX_BYTES) {
    return false
  }
  let pinnedBytes = 0
  let pinnedEntries = 0
  for (const candidate of blobUrlCache.keys()) {
    if (candidate !== key && isLocalImageCacheKeyPinned(candidate)) {
      pinnedBytes += blobUrlCacheBytes.get(candidate) ?? 0
      pinnedEntries += 1
    }
  }
  return (
    pinnedBytes + byteLength <= BLOB_URL_CACHE_MAX_BYTES &&
    (pinnedEntries + 1 <= BLOB_URL_CACHE_MAX_SIZE || isLocalImageCacheKeyPinned(key))
  )
}

export function cacheLocalImageBlob(key: string, url: string, byteLength: number): boolean {
  if (byteLength > BLOB_URL_CACHE_MAX_BYTES) {
    URL.revokeObjectURL(url)
    return false
  }
  const previousUrl = blobUrlCache.get(key)
  const previousBytes = blobUrlCacheBytes.get(key) ?? 0
  let retainedBytes = 0
  for (const bytes of blobUrlCacheBytes.values()) {
    retainedBytes += bytes
  }
  let projectedEntries = blobUrlCache.size + (previousUrl === undefined ? 1 : 0)
  let projectedBytes = retainedBytes - previousBytes + byteLength

  // Active displays share the strict byte budget; the entry target bounds reusable, unleased images.
  while (projectedEntries > BLOB_URL_CACHE_MAX_SIZE || projectedBytes > BLOB_URL_CACHE_MAX_BYTES) {
    const candidate = Array.from(blobUrlCache.keys()).find(
      (candidateKey) => candidateKey !== key && !isLocalImageCacheKeyPinned(candidateKey)
    )
    if (candidate === undefined) {
      if (isLocalImageCacheKeyPinned(key) && projectedBytes <= BLOB_URL_CACHE_MAX_BYTES) {
        break
      }
      URL.revokeObjectURL(url)
      return false
    }
    const candidateUrl = blobUrlCache.get(candidate)
    const candidateBytes = blobUrlCacheBytes.get(candidate) ?? 0
    blobUrlCache.delete(candidate)
    blobUrlCacheBytes.delete(candidate)
    projectedEntries -= 1
    projectedBytes -= candidateBytes
    if (candidateUrl) {
      URL.revokeObjectURL(candidateUrl)
    }
  }
  if (previousUrl !== undefined && previousUrl !== url) {
    URL.revokeObjectURL(previousUrl)
  }
  blobUrlCacheBytes.delete(key)
  blobUrlCacheBytes.set(key, byteLength)
  blobUrlCache.set(key, url)
  return true
}

export function getLocalImageCacheGeneration(): number {
  return cacheGeneration
}

export function unpinLocalImageCache(key: string): void {
  unpinLocalImageCacheKey(key)
  pruneImageCache()
}

export function subscribeToLocalImageCacheInvalidation(listener: () => void): () => void {
  cacheListeners.add(listener)
  return () => cacheListeners.delete(listener)
}

function revokePendingBlobUrls(): void {
  pendingBlobUrlRevocationTimer = null
  for (const url of pendingBlobUrlRevocations) {
    URL.revokeObjectURL(url)
  }
  pendingBlobUrlRevocations.clear()
}

function scheduleBlobUrlRevocation(urls: string[]): void {
  for (const url of urls) {
    pendingBlobUrlRevocations.add(url)
  }
  if (pendingBlobUrlRevocationTimer !== null || pendingBlobUrlRevocations.size === 0) {
    return
  }
  pendingBlobUrlRevocationTimer = setTimeout(revokePendingBlobUrls, 30_000)
}

/** Committed chat attachments never change, so a re-read on focus would only download them again. */
export function isImmutableLocalImageCacheKey(key: string): boolean {
  return isCommittedAgentSessionAttachmentPath(key.slice(key.lastIndexOf('\0') + 1))
}

function matchesCacheKeyPath(key: string, targetPath: string): boolean {
  if (key === targetPath || key.endsWith(`\0${targetPath}`)) {
    return true
  }
  const normalizedTarget = targetPath.replace(/\\/g, '/')
  const lastIndex = key.lastIndexOf('\0')
  const keyPath = lastIndex === -1 ? key : key.slice(lastIndex + 1)
  return keyPath.replace(/\\/g, '/') === normalizedTarget
}

function isImageFilePath(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf('.')
  if (dotIndex === -1) {
    return false
  }
  const mime = IMAGE_AND_PDF_PREVIEW_MIME_TYPES[filePath.slice(dotIndex).toLowerCase()]
  return mime !== undefined && mime !== 'application/pdf'
}

export function invalidateLocalImageCache(targetPath?: string): void {
  const staleUrls: string[] = []
  const shouldInvalidate = (key: string): boolean =>
    !isImmutableLocalImageCacheKey(key) &&
    (targetPath === undefined || matchesCacheKeyPath(key, targetPath))
  for (const [key, url] of blobUrlCache.entries()) {
    if (shouldInvalidate(key)) {
      staleUrls.push(url)
      blobUrlCache.delete(key)
      blobUrlCacheBytes.delete(key)
    }
  }
  for (const key of inFlightBlobUrlLoads.keys()) {
    if (shouldInvalidate(key)) {
      inFlightBlobUrlLoads.delete(key)
    }
  }
  cacheGeneration += 1
  for (const listener of cacheListeners) {
    listener()
  }
  if (staleUrls.length > 0) {
    scheduleBlobUrlRevocation(staleUrls)
  }
}

export function resetLocalImageCacheState(): void {
  if (pendingBlobUrlRevocationTimer !== null) {
    clearTimeout(pendingBlobUrlRevocationTimer)
    pendingBlobUrlRevocationTimer = null
  }
  revokePendingBlobUrls()
  for (const url of blobUrlCache.values()) {
    URL.revokeObjectURL(url)
  }
  blobUrlCache.clear()
  blobUrlCacheBytes.clear()
  clearLocalImageCachePins()
  inFlightBlobUrlLoads.clear()
  cacheGeneration = 0
  pendingBlobUrlRevocations.clear()
  cacheListeners.clear()
}

/** A window shown again without focus (uncovered, restored behind another) gets no focus event. */
function invalidateWhenShownUnfocused(): void {
  if (document.visibilityState === 'visible' && !document.hasFocus()) {
    invalidateLocalImageCache()
  }
}

function handleWorktreeFileChange(
  event: WindowEventMap[typeof ORCA_WORKTREE_FILE_CHANGE_EVENT]
): void {
  const { payload } = event.detail
  if (payload.resync) {
    invalidateLocalImageCache()
    return
  }
  for (const fsEvent of payload.events) {
    if (fsEvent.kind === 'overflow') {
      invalidateLocalImageCache()
      return
    }
    if (isImageFilePath(fsEvent.absolutePath)) {
      invalidateLocalImageCache(fsEvent.absolutePath)
    }
    if (fsEvent.oldAbsolutePath && isImageFilePath(fsEvent.oldAbsolutePath)) {
      invalidateLocalImageCache(fsEvent.oldAbsolutePath)
    }
  }
}

function onWindowFocus(): void {
  invalidateLocalImageCache()
}

export function disposeLocalImageCacheState(): void {
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', onWindowFocus)
    document.removeEventListener('visibilitychange', invalidateWhenShownUnfocused)
    window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleWorktreeFileChange)
  }
  resetLocalImageCacheState()
}

// Every shown image, including one whose read failed, reads again when the window comes back.
if (typeof window !== 'undefined') {
  window.addEventListener('focus', onWindowFocus)
  document.addEventListener('visibilitychange', invalidateWhenShownUnfocused)
  window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, handleWorktreeFileChange)
}

if (import.meta !== undefined && import.meta.hot) {
  import.meta.hot.dispose(disposeLocalImageCacheState)
}
