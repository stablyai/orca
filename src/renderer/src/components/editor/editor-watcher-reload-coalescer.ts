// Why: under sustained writes watch batches can outpace slow (SSH/WSL) reads; restarting the
// read on every batch supersedes each result before it lands, so the tab never updates.
// Allow one watcher-triggered read per key and run exactly one follow-up with the latest change.

// Why: a read through a dead transport may never settle; don't let it block later reloads forever.
const STALE_WATCHER_READ_MS = 10_000

export type EditorWatcherReloadCoalescer = {
  run: (key: string, load: () => Promise<void>) => void
  dispose: () => void
}

type InFlightRead = {
  token: object
  startedAt: number
  replacedStale: boolean
  watchdog: ReturnType<typeof setTimeout> | null
}

export function createEditorWatcherReloadCoalescer(): EditorWatcherReloadCoalescer {
  const inFlight = new Map<string, InFlightRead>()
  const pending = new Map<string, () => Promise<void>>()
  let disposed = false

  const clearWatchdog = (read: InFlightRead): void => {
    if (read.watchdog) {
      clearTimeout(read.watchdog)
      read.watchdog = null
    }
  }

  const start = (key: string, load: () => Promise<void>, replacedStale: boolean): void => {
    const previous = inFlight.get(key)
    if (previous) {
      clearWatchdog(previous)
    }
    const token = {}
    inFlight.set(key, { token, startedAt: Date.now(), replacedStale, watchdog: null })
    void load()
      .catch(() => {})
      .finally(() => {
        const current = inFlight.get(key)
        if (current?.token !== token) {
          return
        }
        clearWatchdog(current)
        inFlight.delete(key)
        const next = pending.get(key)
        pending.delete(key)
        if (next && !disposed) {
          start(key, next, false)
        }
      })
  }

  const replaceStale = (key: string): void => {
    const next = pending.get(key)
    pending.delete(key)
    if (next && !disposed) {
      start(key, next, true)
    }
  }

  return {
    run(key, load) {
      if (disposed) {
        return
      }
      const current = inFlight.get(key)
      if (!current) {
        start(key, load, false)
        return
      }
      pending.set(key, load)
      // Why: replace a stale read once; a read that is merely slow must be allowed to land.
      if (current.replacedStale) {
        return
      }
      const remaining = current.startedAt + STALE_WATCHER_READ_MS - Date.now()
      if (remaining <= 0) {
        replaceStale(key)
        return
      }
      // Why: writes may stop while the read hangs; the queued reload must not wait for another event.
      current.watchdog ??= setTimeout(() => {
        current.watchdog = null
        if (inFlight.get(key) === current) {
          replaceStale(key)
        }
      }, remaining)
    },
    dispose() {
      disposed = true
      pending.clear()
      for (const read of inFlight.values()) {
        clearWatchdog(read)
      }
    }
  }
}
