import type { RuntimeDownloadProgressEvent } from '../../../../../shared/runtime-downloads/runtime-download-contract'

export type RuntimeDownloadProgressSnapshot = RuntimeDownloadProgressEvent & {
  /** Recent receive rate, smoothed so the label does not jitter. */
  bytesPerSecond: number | null
}

type Entry = {
  snapshot: RuntimeDownloadProgressSnapshot | null
  listeners: Set<() => void>
  lastSample: { at: number; bytes: number } | null
}

const entries = new Map<string, Entry>()
let unsubscribeIpc: (() => void) | null = null
// Rate is averaged over this window; shorter windows swing with every page.
const RATE_SMOOTHING = 0.3

function entryFor(downloadId: string): Entry {
  let entry = entries.get(downloadId)
  if (!entry) {
    entry = { snapshot: null, listeners: new Set(), lastSample: null }
    entries.set(downloadId, entry)
  }
  return entry
}

export function applyRuntimeDownloadProgress(
  event: RuntimeDownloadProgressEvent,
  now = performance.now()
): void {
  const entry = entries.get(event.downloadId)
  if (!entry) {
    return
  }
  let bytesPerSecond = entry.snapshot?.bytesPerSecond ?? null
  if (entry.lastSample && now > entry.lastSample.at) {
    const instant =
      ((event.receivedBytes - entry.lastSample.bytes) * 1000) / (now - entry.lastSample.at)
    bytesPerSecond =
      bytesPerSecond === null
        ? instant
        : bytesPerSecond + RATE_SMOOTHING * (instant - bytesPerSecond)
  }
  entry.lastSample = { at: now, bytes: event.receivedBytes }
  entry.snapshot = { ...event, bytesPerSecond }
  for (const listener of entry.listeners) {
    listener()
  }
}

/** Starts tracking a download; returns a release that forgets it once its toast is done. */
export function trackRuntimeDownload(downloadId: string): () => void {
  entryFor(downloadId)
  if (!unsubscribeIpc && window.api.runtimeDownloads) {
    unsubscribeIpc = window.api.runtimeDownloads.onProgress((event) =>
      applyRuntimeDownloadProgress(event)
    )
  }
  return () => {
    entries.delete(downloadId)
    if (entries.size === 0 && unsubscribeIpc) {
      unsubscribeIpc()
      unsubscribeIpc = null
    }
  }
}

export function subscribeRuntimeDownloadProgress(
  downloadId: string,
  listener: () => void
): () => void {
  const entry = entryFor(downloadId)
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
  }
}

export function getRuntimeDownloadProgress(
  downloadId: string
): RuntimeDownloadProgressSnapshot | null {
  return entries.get(downloadId)?.snapshot ?? null
}
