import {
  browserGuestActivity,
  retiredBrowserGuestResources,
  onBrowserGuestActivity,
  type BrowserGuestActivity
} from './browser-guest-activity'

export const BROWSER_GUEST_HIDDEN_PAGE_RETENTION_LIMIT = 32
const RECENT_SELECTION_MS = 30 * 60_000

/** Refused owners park until their own lifecycle changes; recency has one window-level wake. */
export function installBrowserGuestPageRetention(args: {
  isBlocked: (pageId: string) => boolean
  discard: (pageId: string, webview: Electron.WebviewTag, webContentsId: number) => boolean
  limit?: number
}): () => void {
  const hidden = new Set<string>()
  const candidates = new Map<string, { entry: BrowserGuestActivity; lastUsed: number }>()
  const recent = new Map<string, { entry: BrowserGuestActivity; expires: number }>()
  const limit = args.limit ?? BROWSER_GUEST_HIDDEN_PAGE_RETENTION_LIMIT
  let disposed = false
  let scheduled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const overBudget = (): boolean => hidden.size + retiredBrowserGuestResources.size > limit
  const schedule = (): void => {
    if (disposed || scheduled || !overBudget()) {
      return
    }
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (disposed || retiredBrowserGuestResources.size >= 4) {
        return
      }
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      const now = Date.now()
      for (const [pageId, parked] of recent) {
        if (parked.expires > now) {
          break
        }
        recent.delete(pageId)
        candidates.set(pageId, { entry: parked.entry, lastUsed: parked.entry.lastUsed })
      }
      for (const [pageId, { entry }] of candidates) {
        if (!overBudget() || retiredBrowserGuestResources.size >= 4) {
          break
        }
        candidates.delete(pageId)
        if (browserGuestActivity.get(pageId) !== entry || entry.visible || args.isBlocked(pageId)) {
          continue
        }
        try {
          if (args.discard(pageId, entry.webview, entry.webview.getWebContentsId())) {
            hidden.delete(pageId)
          }
        } catch {
          // A detached/unknown owner remains counted and parked until its own lifecycle update.
        }
      }
      const first = recent.values().next().value
      if (overBudget() && first) {
        timer = setTimeout(
          () => {
            timer = null
            schedule()
          },
          Math.max(1, first.expires - Date.now())
        )
      }
    })
  }
  const update = (pageId: string): void => {
    const entry = browserGuestActivity.get(pageId)
    if (entry && !entry.visible) {
      hidden.add(pageId)
    } else {
      hidden.delete(pageId)
    }
    if (!entry || entry.visible || args.isBlocked(pageId)) {
      candidates.delete(pageId)
      recent.delete(pageId)
    } else {
      const expires = entry.lastSelectedAt + RECENT_SELECTION_MS
      if (expires > Date.now()) {
        candidates.delete(pageId)
        if (recent.get(pageId)?.expires !== expires) {
          recent.delete(pageId)
          recent.set(pageId, { entry, expires })
        }
      } else {
        recent.delete(pageId)
        if (candidates.get(pageId)?.lastUsed !== entry.lastUsed) {
          candidates.delete(pageId)
        }
        candidates.set(pageId, { entry, lastUsed: entry.lastUsed })
      }
    }
    schedule()
  }
  const removeListener = onBrowserGuestActivity(update)
  // Only initial installation needs to order already-existing selection times.
  for (const [pageId] of [...browserGuestActivity].sort(
    (a, b) => a[1].lastSelectedAt - b[1].lastSelectedAt
  )) {
    update(pageId)
  }
  return () => {
    disposed = true
    removeListener()
    hidden.clear()
    candidates.clear()
    recent.clear()
    if (timer) {
      clearTimeout(timer)
    }
  }
}
