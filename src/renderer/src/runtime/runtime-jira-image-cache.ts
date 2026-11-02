import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import {
  JIRA_IMAGE_MAX_BYTES,
  JIRA_IMAGE_MAX_REFERENCES,
  JIRA_IMAGE_MAX_PENDING_READS
} from '../../../shared/jira-attachment-image'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { readRuntimeJiraImage } from './runtime-jira-image-client'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged
} from './runtime-environment-revision'
import { createBrowserUuid } from '@/lib/browser-uuid'

const MAX_CACHE_BYTES = 24 * 1024 * 1024
const MAX_CACHE_ENTRIES = 96
const CACHE_TTL_MS = 30 * 60_000
const downloads = new PrioritySemaphore(3)
type ImageEntry = { url: string; bytes: number; users: number; expiresAt: number }
const entries = new Map<string, ImageEntry>()
const pending = new Map<
  string,
  { promise: Promise<void>; controller: AbortController; users: number }
>()
const invalidationListeners = new Set<(environmentId: string | null) => void>()
const disconnectedHosts = new Set<string>()
const lastHostStatusSequences = new Map<string, number>()
let expiryTimer: ReturnType<typeof setTimeout> | undefined

function imageOwner(target: RuntimeClientTarget): string {
  return target.kind === 'environment' ? target.environmentId : 'local'
}

function imageKey(target: RuntimeClientTarget, reference: string): string {
  const revision =
    target.kind === 'environment' ? getRuntimeEnvironmentRevision(target.environmentId) : 0
  return `${imageOwner(target)}::${revision ?? 0}::${reference}`
}

function removeEntry(key: string, entry: ImageEntry): void {
  URL.revokeObjectURL(entry.url)
  entries.delete(key)
}

function scheduleExpiry(): void {
  clearTimeout(expiryTimer)
  const expiresAt = Math.min(
    ...[...entries.values()].filter((entry) => entry.users === 0).map((entry) => entry.expiresAt)
  )
  expiryTimer = Number.isFinite(expiresAt)
    ? setTimeout(
        () => {
          evictUnused()
          scheduleExpiry()
        },
        Math.max(1, expiresAt - Date.now())
      )
    : undefined
}

function evictUnused(requiredBytes = 0): boolean {
  for (const [key, entry] of entries) {
    if (entry.users === 0 && entry.expiresAt <= Date.now()) {
      removeEntry(key, entry)
    }
  }
  let bytes = [...entries.values()].reduce((total, entry) => total + entry.bytes, 0)
  for (const [key, entry] of entries) {
    if (bytes + requiredBytes <= MAX_CACHE_BYTES && entries.size < MAX_CACHE_ENTRIES) {
      break
    }
    if (entry.users > 0) {
      continue
    }
    removeEntry(key, entry)
    bytes -= entry.bytes
  }
  return bytes + requiredBytes <= MAX_CACHE_BYTES && entries.size < MAX_CACHE_ENTRIES
}

function saveImage(key: string, blob: Blob): boolean {
  if (!evictUnused(blob.size)) {
    return false
  }
  entries.set(key, {
    url: URL.createObjectURL(blob),
    bytes: blob.size,
    users: 0,
    expiresAt: Date.now() + CACHE_TTL_MS
  })
  scheduleExpiry()
  return true
}

export async function acquireJiraImageUrl(
  target: RuntimeClientTarget,
  reference: string,
  signal: AbortSignal
): Promise<{ url: string; release: () => void }> {
  if (signal.aborted) {
    throw signal.reason
  }
  evictUnused()
  const key = imageKey(target, reference)
  let entry = entries.get(key)
  if (!entry) {
    let loading = pending.get(key)
    if (!loading || loading.controller.signal.aborted) {
      if (pending.size >= JIRA_IMAGE_MAX_PENDING_READS) {
        throw new Error('Jira image queue is full.')
      }
      const controller = new AbortController()
      loading = {
        controller,
        users: 0,
        promise: (async () => {
          const release = await downloads.acquire(0, controller.signal)
          try {
            const blob = await readRuntimeJiraImage(target, reference, controller.signal)
            if (controller.signal.aborted || key !== imageKey(target, reference)) {
              return
            }
            if (!saveImage(key, blob)) {
              throw new Error('Jira image cache is full.')
            }
          } finally {
            release()
          }
        })().finally(() => {
          if (pending.get(key)?.controller === controller) {
            pending.delete(key)
          }
        })
      }
      pending.set(key, loading)
    }
    const owned = loading
    owned.users += 1
    try {
      await waitForPromiseWithSignal(owned.promise, signal)
    } finally {
      owned.users -= 1
      if (owned.users === 0 && pending.get(key) === owned) {
        owned.controller.abort()
      }
    }
    entry = entries.get(key)
  }
  if (!entry || signal.aborted) {
    throw new Error('Jira image is unavailable.')
  }
  entries.delete(key)
  entries.set(key, entry)
  entry.users += 1
  scheduleExpiry()
  const owned = entry
  let released = false
  return {
    url: owned.url,
    release: () => {
      if (released) {
        return
      }
      released = true
      owned.users -= 1
      evictUnused()
      scheduleExpiry()
    }
  }
}

export function migrateLegacyJiraImages(content: string, target: RuntimeClientTarget): string {
  let admitted = 0
  return content.replace(
    /(!\[(?:\\.|[^\\\]])*\]\()data:(image\/(?:png|jpeg|gif|webp|bmp|avif|tiff|x-icon));base64,([A-Za-z0-9+/=]+)(\))/g,
    (_url, prefix: string, mimeType: string, encoded: string, suffix: string) => {
      if (
        ++admitted > JIRA_IMAGE_MAX_REFERENCES ||
        encoded.length > Math.ceil(JIRA_IMAGE_MAX_BYTES / 3) * 4
      ) {
        return `${prefix}${suffix}`
      }
      try {
        const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
        if (bytes.byteLength === 0 || bytes.byteLength > JIRA_IMAGE_MAX_BYTES) {
          return `${prefix}${suffix}`
        }
        const reference = createBrowserUuid()
        if (!saveImage(imageKey(target, reference), new Blob([bytes], { type: mimeType }))) {
          return `${prefix}${suffix}`
        }
        return `${prefix}orca-jira-image://attachment/${reference}${suffix}`
      } catch {
        return `${prefix}${suffix}`
      }
    }
  )
}

export function hasCachedJiraImage(target: RuntimeClientTarget, reference: string): boolean {
  evictUnused()
  return entries.has(imageKey(target, reference))
}

export function onJiraImageCacheInvalidated(
  listener: (environmentId: string | null) => void
): () => void {
  invalidationListeners.add(listener)
  return () => invalidationListeners.delete(listener)
}

export function clearJiraImageCache(environmentId?: string): void {
  const prefix = environmentId ? `${environmentId}::` : null
  for (const [key, entry] of entries) {
    if (!prefix || key.startsWith(prefix)) {
      removeEntry(key, entry)
    }
  }
  for (const [key, download] of pending) {
    if (!prefix || key.startsWith(prefix)) {
      download.controller.abort()
      pending.delete(key)
    }
  }
  scheduleExpiry()
  for (const listener of invalidationListeners) {
    listener(environmentId ?? null)
  }
}

export function observeJiraImageHostStatus(snapshot: RuntimeHostStatusSnapshot): void {
  if (
    getRuntimeEnvironmentRevision(snapshot.environmentId) !== snapshot.pairingRevision ||
    (lastHostStatusSequences.get(snapshot.environmentId) ?? -1) >= snapshot.sequence
  ) {
    return
  }
  lastHostStatusSequences.set(snapshot.environmentId, snapshot.sequence)
  if (snapshot.retired || snapshot.verification === 'blocked') {
    disconnectedHosts.delete(snapshot.environmentId)
    clearJiraImageCache(snapshot.environmentId)
  } else if (snapshot.transport === 'disconnected') {
    disconnectedHosts.add(snapshot.environmentId)
    clearJiraImageCache(snapshot.environmentId)
  } else if (
    snapshot.transport === 'ready' &&
    snapshot.verification === 'verified' &&
    disconnectedHosts.delete(snapshot.environmentId)
  ) {
    clearJiraImageCache(snapshot.environmentId)
  }
}

function forgetJiraImageHost(environmentId: string): void {
  disconnectedHosts.delete(environmentId)
  lastHostStatusSequences.delete(environmentId)
  clearJiraImageCache(environmentId)
}

onRuntimeEnvironmentsRetired((ids) => ids.forEach(forgetJiraImageHost))
onRuntimeEnvironmentRevisionsChanged((ids) => ids.forEach(forgetJiraImageHost))
