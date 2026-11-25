import { useState } from 'react'
import type { PluginListEntry } from '../list/plugin-list-entries'

/** The Updates list's "Update all…" dialog. The held-update toast opens its own over the app. */
export function usePluginUpdateDialog() {
  // Why a count: each open mounts a fresh dialog, so its previews and results start clean.
  const [opens, setOpens] = useState(0)
  const [entries, setEntries] = useState<readonly PluginListEntry[] | null>(null)
  const open = (next: readonly PluginListEntry[]): void => {
    setOpens((count) => count + 1)
    setEntries(next)
  }
  return { opens, entries, open, close: () => setEntries(null) }
}
