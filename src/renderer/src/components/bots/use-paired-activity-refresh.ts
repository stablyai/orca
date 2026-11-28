// A paired computer announces no change to this window, so while the bot has workspaces handed to it
// there, Activity re-reads on a backing-off timer, only while the window is visible. It follows the
// registrations, not the rows shown: an offline or empty answer must not end it.
import { useEffect } from 'react'

export const PAIRED_AGENTS_FIRST_REFRESH_MS = 15_000
export const PAIRED_AGENTS_MAX_REFRESH_MS = 120_000

type SharedPairedRefresh = {
  callbacks: Set<() => void>
  delay: number
  timer: number
}

// One timer per (host read store, bot) so concurrent surfaces never schedule offset duplicate polls.
const sharedRefreshes = new WeakMap<object, Map<string, SharedPairedRefresh>>()

export function usePairedActivityRefresh(
  active: boolean,
  scope: object,
  key: string | null,
  refresh: () => void
): void {
  useEffect(() => {
    if (!active || !key) {
      return
    }
    let byKey = sharedRefreshes.get(scope)
    if (!byKey) {
      byKey = new Map()
      sharedRefreshes.set(scope, byKey)
    }
    let entry = byKey.get(key)
    if (!entry) {
      const created: SharedPairedRefresh = {
        callbacks: new Set(),
        delay: PAIRED_AGENTS_FIRST_REFRESH_MS,
        timer: 0
      }
      const next = (): void => {
        created.timer = window.setTimeout(() => {
          if (document.visibilityState === 'visible') {
            const [run] = created.callbacks
            run?.()
          }
          if (created.callbacks.size === 0) {
            return
          }
          created.delay = Math.min(created.delay * 2, PAIRED_AGENTS_MAX_REFRESH_MS)
          next()
        }, created.delay)
      }
      byKey.set(key, created)
      next()
      entry = created
    }
    entry.callbacks.add(refresh)
    return () => {
      entry.callbacks.delete(refresh)
      if (entry.callbacks.size === 0) {
        window.clearTimeout(entry.timer)
        byKey.delete(key)
        if (byKey.size === 0) {
          sharedRefreshes.delete(scope)
        }
      }
    }
  }, [active, scope, key, refresh])
}
