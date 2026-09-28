import { isTimestampParameterHost } from '../../../../../shared/browser-url-equivalence'
import { webviewRegistry } from './webview-registry'

export type BrowserPageMediaProgress = {
  currentTime: number
  paused: boolean
  playbackRate: number
}

export type BrowserPageProgressSnapshot = {
  url: string
  scrollX: number
  scrollY: number
  media?: BrowserPageMediaProgress | null
  timestamp: number
}

const progressByTabId = new Map<string, BrowserPageProgressSnapshot>()
const pendingRestorationByTabId = new Map<string, BrowserPageProgressSnapshot>()
let progressTrackerInterval: number | null = null

const PROGRESS_TRACKER_INTERVAL_MS = 5000

const CAPTURE_SCRIPT = `(() => {
  try {
    function findMedia(root) {
      if (!root) return null;
      const el = root.querySelector('video, audio');
      if (el) return el;
      for (const node of root.querySelectorAll('*')) {
        if (node.shadowRoot) {
          const nested = findMedia(node.shadowRoot);
          if (nested) return nested;
        }
      }
      return null;
    }
    const media = findMedia(document);
    let mediaState = null;
    if (media && typeof media.currentTime === 'number' && !isNaN(media.currentTime) && media.currentTime > 0) {
      mediaState = {
        currentTime: media.currentTime,
        paused: Boolean(media.paused),
        playbackRate: typeof media.playbackRate === 'number' ? media.playbackRate : 1
      };
    }
    return {
      url: window.location.href,
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0,
      media: mediaState
    };
  } catch {
    return null;
  }
})()`

export function recordBrowserPageProgress(
  browserTabId: string,
  snapshot: BrowserPageProgressSnapshot
): void {
  progressByTabId.set(browserTabId, snapshot)
}

export function getBrowserPageProgress(browserTabId: string): BrowserPageProgressSnapshot | null {
  return progressByTabId.get(browserTabId) ?? null
}

export function clearBrowserPageProgress(browserTabId: string): void {
  progressByTabId.delete(browserTabId)
  pendingRestorationByTabId.delete(browserTabId)
}

export function stageBrowserPageProgressRestoration(
  browserTabId: string
): BrowserPageProgressSnapshot | null {
  const snapshot = progressByTabId.get(browserTabId) ?? null
  if (snapshot) {
    pendingRestorationByTabId.set(browserTabId, snapshot)
  }
  return snapshot
}

export function consumePendingBrowserPageProgressRestoration(
  browserTabId: string
): BrowserPageProgressSnapshot | null {
  const pending = pendingRestorationByTabId.get(browserTabId) ?? null
  pendingRestorationByTabId.delete(browserTabId)
  return pending
}

export function formatRestoredBrowserUrl(
  rawUrl: string,
  media?: BrowserPageMediaProgress | null
): string {
  if (!media || typeof media.currentTime !== 'number' || media.currentTime <= 0) {
    return rawUrl
  }
  try {
    const parsed = new URL(rawUrl)
    if (isTimestampParameterHost(parsed.hostname)) {
      const seconds = Math.floor(media.currentTime)
      if (seconds > 0) {
        parsed.searchParams.set('t', `${seconds}s`)
        return parsed.toString()
      }
    }
  } catch {
    // If URL parsing fails, return original rawUrl unchanged.
  }
  return rawUrl
}

export async function captureBrowserPageProgress(
  browserTabId: string,
  webview: Electron.WebviewTag
): Promise<BrowserPageProgressSnapshot | null> {
  if (!webview || typeof webview.executeJavaScript !== 'function') {
    return null
  }
  try {
    const raw = await webview.executeJavaScript(CAPTURE_SCRIPT)
    if (!raw || typeof raw !== 'object') {
      return null
    }
    const rawObj = raw as {
      url?: unknown
      scrollX?: unknown
      scrollY?: unknown
      media?: { currentTime?: unknown; paused?: unknown; playbackRate?: unknown } | null
    }
    const snapshot: BrowserPageProgressSnapshot = {
      url: typeof rawObj.url === 'string' && rawObj.url ? rawObj.url : '',
      scrollX:
        typeof rawObj.scrollX === 'number' && Number.isFinite(rawObj.scrollX) ? rawObj.scrollX : 0,
      scrollY:
        typeof rawObj.scrollY === 'number' && Number.isFinite(rawObj.scrollY) ? rawObj.scrollY : 0,
      media:
        rawObj.media &&
        typeof rawObj.media.currentTime === 'number' &&
        Number.isFinite(rawObj.media.currentTime)
          ? {
              currentTime: rawObj.media.currentTime,
              paused: Boolean(rawObj.media.paused),
              playbackRate:
                typeof rawObj.media.playbackRate === 'number' &&
                Number.isFinite(rawObj.media.playbackRate)
                  ? rawObj.media.playbackRate
                  : 1
            }
          : null,
      timestamp: Date.now()
    }
    recordBrowserPageProgress(browserTabId, snapshot)
    return snapshot
  } catch {
    return null
  }
}

export async function captureAllLiveBrowserPageProgress(): Promise<void> {
  const promises: Promise<unknown>[] = []
  for (const [tabId, webview] of webviewRegistry.entries()) {
    promises.push(captureBrowserPageProgress(tabId, webview))
  }
  await Promise.allSettled(promises)
}

export function restoreBrowserPageProgress(
  webview: Electron.WebviewTag,
  snapshot: BrowserPageProgressSnapshot
): void {
  if (!webview || typeof webview.executeJavaScript !== 'function') {
    return
  }
  const scrollX = snapshot.scrollX > 0 ? snapshot.scrollX : 0
  const scrollY = snapshot.scrollY > 0 ? snapshot.scrollY : 0
  const hasMedia = snapshot.media && snapshot.media.currentTime > 0
  const targetTime = hasMedia ? snapshot.media!.currentTime : 0
  const wasPaused = hasMedia ? snapshot.media!.paused : true
  const targetRate = hasMedia ? snapshot.media!.playbackRate : 1

  const script = `(() => {
    try {
      const sx = ${JSON.stringify(scrollX)};
      const sy = ${JSON.stringify(scrollY)};
      if (sx > 0 || sy > 0) {
        window.scrollTo(sx, sy);
      }
      ${
        hasMedia
          ? `
      const targetTime = ${JSON.stringify(targetTime)};
      const wasPaused = ${JSON.stringify(wasPaused)};
      const targetRate = ${JSON.stringify(targetRate)};
      function findMedia(root) {
        if (!root) return null;
        const el = root.querySelector('video, audio');
        if (el) return el;
        for (const node of root.querySelectorAll('*')) {
          if (node.shadowRoot) {
            const nested = findMedia(node.shadowRoot);
            if (nested) return nested;
          }
        }
        return null;
      }
      const applyMedia = () => {
        const media = findMedia(document);
        if (!media) return false;
        if (typeof media.currentTime === 'number' && Math.abs(media.currentTime - targetTime) > 2) {
          media.currentTime = targetTime;
        }
        if (targetRate && media.playbackRate !== targetRate) {
          media.playbackRate = targetRate;
        }
        if (!wasPaused && media.paused) {
          media.play().catch(() => {});
        } else if (wasPaused && !media.paused) {
          media.pause();
        }
        return true;
      };
      if (!applyMedia()) {
        [200, 600, 1500, 3000].forEach((delay) => {
          setTimeout(applyMedia, delay);
        });
      }
      `
          : ''
      }
    } catch {}
  })()`

  void webview.executeJavaScript(script).catch(() => {})
}

export function ensureBrowserPageProgressTracking(): void {
  if (progressTrackerInterval !== null) {
    return
  }
  const timerFn =
    typeof window !== 'undefined' && typeof window.setInterval === 'function'
      ? window.setInterval.bind(window)
      : typeof setInterval === 'function'
        ? setInterval
        : null
  if (!timerFn) {
    return
  }
  // Why: each tick runs a shadow-DOM traversal per live page; dock/detach capture
  // explicitly, so this is only a crash/OS-close safety net and can be sparse.
  progressTrackerInterval = timerFn(() => {
    if (webviewRegistry.size === 0) {
      return
    }
    for (const [tabId, webview] of webviewRegistry.entries()) {
      void captureBrowserPageProgress(tabId, webview)
    }
  }, PROGRESS_TRACKER_INTERVAL_MS) as unknown as number
}

export function stopBrowserPageProgressTracking(): void {
  if (progressTrackerInterval !== null) {
    const clearFn =
      typeof window !== 'undefined' && typeof window.clearInterval === 'function'
        ? window.clearInterval.bind(window)
        : typeof clearInterval === 'function'
          ? clearInterval
          : null
    clearFn?.(progressTrackerInterval)
    progressTrackerInterval = null
  }
}
