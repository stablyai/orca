import {
  browserGuestActivity,
  retiredBrowserGuestResources,
  onBrowserGuestActivity
} from './browser-guest-activity'
import { BrowserGuestPriorityIndex } from './browser-guest-priority-index'

export const BROWSER_GUEST_HIDDEN_PAGE_RETENTION_LIMIT = 32
const RECENT_SELECTION_MS = 30 * 60_000

/** Refused owners park until their own lifecycle changes; recency has one window-level wake. */
export function installBrowserGuestPageRetention(args: {
  isBlocked: (pageId: string) => boolean
  discard: (pageId: string, webview: Electron.WebviewTag, webContentsId: number) => boolean
  limit?: number
}): () => void {
  const hidden = new Set<string>()
  const candidates = new BrowserGuestPriorityIndex()
  const recent = new BrowserGuestPriorityIndex()
  const limit = args.limit ?? BROWSER_GUEST_HIDDEN_PAGE_RETENTION_LIMIT
  let disposed = false
  let scheduled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const overBudget = (): boolean => hidden.size + retiredBrowserGuestResources.size > limit
  const schedule = (): void => {
    if (disposed || scheduled) {
      return
    }
    if (!overBudget()) {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      return
    }
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (disposed) {
        return
      }
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (retiredBrowserGuestResources.size >= 4) {
        return
      }
      const now = Date.now()
      while (recent.peek()) {
        const next = recent.peek()
        if (!next || next.key > now) {
          break
        }
        const { pageId, entry } = next
        recent.delete(pageId)
        if (
          browserGuestActivity.get(pageId) === entry &&
          !entry.visible &&
          !args.isBlocked(pageId)
        ) {
          candidates.set(pageId, entry, entry.lastUsed)
        }
      }
      while (overBudget() && retiredBrowserGuestResources.size < 4 && candidates.peek()) {
        const next = candidates.pop()
        if (!next) {
          break
        }
        const { pageId, entry } = next
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
      const first = recent.peek()
      if (overBudget() && retiredBrowserGuestResources.size < 4 && first) {
        timer = setTimeout(
          () => {
            timer = null
            schedule()
          },
          Math.max(1, first.key - Date.now())
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
        recent.set(pageId, entry, expires)
      } else {
        recent.delete(pageId)
        candidates.set(pageId, entry, entry.lastUsed)
      }
    }
    schedule()
  }
  const removeListener = onBrowserGuestActivity(update)
  for (const [pageId] of browserGuestActivity) {
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
