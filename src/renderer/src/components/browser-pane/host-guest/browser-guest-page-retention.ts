import type { BrowserGuestDiscardProtection } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'
import {
  browserGuestActivity,
  onBrowserGuestActivity,
  type BrowserGuestActivity
} from './browser-guest-activity'

export const BROWSER_GUEST_HIDDEN_PAGE_RETENTION_LIMIT = 20

/** One ordered pool, updated only for the page that changed; parked guests own no timers. */
export function installBrowserGuestPageRetention(args: {
  isBlocked: (pageId: string) => boolean
  getProtection: (
    pageId: string,
    webContentsId: number
  ) => Promise<BrowserGuestDiscardProtection | null>
  destroy: (pageId: string) => void
  limit?: number
}): () => void {
  const eligible = new Map<string, BrowserGuestActivity>()
  const pending = new Set<string>()
  let disposed = false
  let scheduled = false
  let running = false
  let followup = false
  const limit = args.limit ?? BROWSER_GUEST_HIDDEN_PAGE_RETENTION_LIMIT
  const isCurrent = (pageId: string, entry: BrowserGuestActivity, revision: number): boolean =>
    !disposed &&
    browserGuestActivity.get(pageId) === entry &&
    entry.revision === revision &&
    !entry.visible &&
    !args.isBlocked(pageId)

  const schedule = (): void => {
    if (disposed || eligible.size <= limit) {
      return
    }
    if (running) {
      followup = true
      return
    }
    if (scheduled) {
      return
    }
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (disposed) {
        return
      }
      running = true
      const cursor = [...eligible.entries()]
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
        .values()
      let admitted = 0
      const excess = eligible.size - limit
      const worker = async (): Promise<void> => {
        while (!disposed && eligible.size > limit && admitted < excess) {
          const next = cursor.next()
          if (next.done) {
            return
          }
          const [pageId, entry] = next.value
          if (pending.has(pageId)) {
            continue
          }
          admitted += 1
          const revision = entry.revision
          if (!isCurrent(pageId, entry, revision)) {
            continue
          }
          let webContentsId: number
          try {
            webContentsId = entry.webview.getWebContentsId()
          } catch {
            eligible.delete(pageId)
            continue
          }
          pending.add(pageId)
          let protection: BrowserGuestDiscardProtection | null = null
          try {
            protection = await args.getProtection(pageId, webContentsId)
          } catch {
            // Unknown state parks until a real lifecycle or observer transition.
          } finally {
            pending.delete(pageId)
          }
          if (!isCurrent(pageId, entry, revision)) {
            continue
          }
          try {
            if (entry.webview.getWebContentsId() !== webContentsId) {
              continue
            }
          } catch {
            continue
          }
          if (
            !protection ||
            protection.webContentsId !== webContentsId ||
            protection.protection !== 'discardable'
          ) {
            eligible.delete(pageId)
            continue
          }
          if (eligible.size > limit) {
            eligible.delete(pageId)
            args.destroy(pageId)
          }
        }
      }
      void Promise.all(Array.from({ length: 4 }, worker)).finally(() => {
        running = false
        if (followup) {
          followup = false
          schedule()
        }
      })
    })
  }
  const update = (pageId: string): void => {
    eligible.delete(pageId)
    const entry = browserGuestActivity.get(pageId)
    if (entry && !entry.visible && !args.isBlocked(pageId)) {
      eligible.set(pageId, entry)
    }
    schedule()
  }
  const removeListener = onBrowserGuestActivity(update)
  for (const pageId of browserGuestActivity.keys()) {
    update(pageId)
  }
  return () => {
    disposed = true
    removeListener()
    eligible.clear()
  }
}
