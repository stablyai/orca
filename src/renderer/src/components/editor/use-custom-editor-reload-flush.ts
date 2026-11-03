import { useEffect, useState } from 'react'
import type { PluginFrameEntryState } from '../right-sidebar/use-plugin-frame-entry'

type ReadyEntry = Extract<PluginFrameEntryState, { status: 'ready' }>

/**
 * The entry to render: on a reload (new revision) the old document stays mounted until `flush`
 * settles, so edits still in its debounce window reach the buffer before the frame is replaced.
 * `flush` is bounded by the host's deadline and settles at once for a frame already reset.
 */
export function useCustomEditorReloadFlush(
  entry: PluginFrameEntryState,
  flush: () => Promise<unknown>
): PluginFrameEntryState {
  const [previous, setPrevious] = useState(entry)
  const [held, setHeld] = useState<ReadyEntry | null>(null)
  if (previous !== entry) {
    setPrevious(entry)
    if (
      held === null &&
      previous.status === 'ready' &&
      entry.status === 'ready' &&
      entry.revision !== previous.revision
    ) {
      setHeld(previous)
    }
  }

  useEffect(() => {
    if (!held) {
      return
    }
    let cancelled = false
    void flush()
      .catch(() => false)
      .then(() => {
        if (!cancelled) {
          setHeld(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [held, flush])

  // Why not held while unready: a suspended or failed entry has no frame worth waiting on.
  return held && entry.status === 'ready' ? held : entry
}
