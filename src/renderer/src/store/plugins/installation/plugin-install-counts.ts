import { create } from 'zustand'

/** Public install counts by plugin key, mirrored from main; display only. */
export const usePluginInstallCountsStore = create<{ counts: Record<string, number> }>(() => ({
  counts: {}
}))

let watching = false

function loadInstallCounts(): void {
  const plugins = window.api?.plugins
  if (!plugins?.getInstallCounts) {
    return
  }
  void plugins
    .getInstallCounts()
    .then((counts) => usePluginInstallCountsStore.setState({ counts }))
    // Why ignored: an older host has no counts; they just stay hidden.
    .catch(() => undefined)
}

/** Reads counts, which also lets main refresh stale ones; safe to call on every catalog view. */
export function requestPluginInstallCounts(): void {
  const plugins = window.api?.plugins
  if (!watching && plugins?.onInstallCountsChanged) {
    watching = true
    plugins.onInstallCountsChanged(loadInstallCounts)
  }
  loadInstallCounts()
}
