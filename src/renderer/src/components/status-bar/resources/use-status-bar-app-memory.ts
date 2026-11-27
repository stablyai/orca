import { useEffect, useRef, useState } from 'react'
import { useWindowActive } from '@/lib/window-activity/use-window-active'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'

export const STATUS_BAR_APP_MEMORY_POLL_MS = 30_000
// Why: lets a tick land on schedule while focus flapping inside one interval reuses the last sample.
const TICK_SLACK_MS = 2_000

function usableBytes(total: number | null): number | null {
  return typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : null
}

/** Orca app memory for the status bar. The timer exists only while this window is focused,
 *  shown and not minimized (as main reports it); disabled, nothing subscribes or polls. */
export function useStatusBarAppMemory(enabled: boolean): number | null {
  const active = useWindowActive(enabled)
  const [bytes, setBytes] = useState<number | null>(null)
  // generation is bumped on disable so an answer from before can't repaint a stale value.
  const samplingRef = useRef({ sampledAt: -Infinity, generation: 0 })

  // Why render-time: clearing in an effect would paint the old value for a frame.
  if (!enabled && bytes !== null) {
    setBytes(null)
  }
  useEffect(() => {
    if (!enabled) {
      return
    }
    const sampling = samplingRef.current
    return () => {
      sampling.generation++
      sampling.sampledAt = -Infinity
    }
  }, [enabled])

  useEffect(() => {
    if (!active) {
      return
    }
    const sampling = samplingRef.current
    const sampleIfStale = (): void => {
      if (Date.now() - sampling.sampledAt < STATUS_BAR_APP_MEMORY_POLL_MS - TICK_SLACK_MS) {
        return
      }
      sampling.sampledAt = Date.now()
      const requestGeneration = sampling.generation
      void window.api.memory
        .getAppMemoryTotal()
        .then((total) => {
          if (sampling.generation === requestGeneration) {
            setBytes(usableBytes(total))
          }
        })
        .catch(() => {})
    }
    return installWindowVisibilityInterval({
      run: sampleIfStale,
      intervalMs: STATUS_BAR_APP_MEMORY_POLL_MS
    })
  }, [active])

  return bytes
}
