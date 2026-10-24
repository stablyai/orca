import { useCallback, useRef, useState } from 'react'
import type { PluginHostListEntry } from '../../../../../preload/api-types'
import { pluginNeedsReview } from '../presentation/plugin-status-presentation'

/**
 * Which plugin's review is open, plus the ones waiting behind it (an Update all that left several
 * needing review). Closing one review opens the next that still needs it.
 */
export function usePluginReviewQueue(): {
  reviewKey: string | null
  /** Opens this review now (or closes with null); the queue is kept. */
  show: (pluginKey: string | null) => void
  enqueue: (pluginKeys: readonly string[]) => void
  /** After a decision: opens the next waiting review that the list still says needs one. */
  advance: (plugins: readonly PluginHostListEntry[]) => void
  /** Drops reviews for plugins no longer installed. */
  prune: (installedKeys: ReadonlySet<string>) => void
  /** Back pauses queued reviews without consuming the next one. */
  pause: () => void
  clear: () => void
} {
  const [reviewKey, setReviewKey] = useState<string | null>(null)
  const currentRef = useRef<string | null>(null)
  const waitingRef = useRef<string[]>([])

  const show = useCallback((pluginKey: string | null) => {
    currentRef.current = pluginKey
    setReviewKey(pluginKey)
  }, [])
  const enqueue = useCallback(
    (pluginKeys: readonly string[]) => {
      const fresh = pluginKeys.filter(
        (key) => key !== currentRef.current && !waitingRef.current.includes(key)
      )
      waitingRef.current.push(...fresh)
      if (currentRef.current === null) {
        show(waitingRef.current.shift() ?? null)
      }
    },
    [show]
  )
  const advance = useCallback(
    (plugins: readonly PluginHostListEntry[]) => {
      const needing = new Set(plugins.filter(pluginNeedsReview).map((plugin) => plugin.pluginKey))
      waitingRef.current = waitingRef.current.filter((key) => needing.has(key))
      show(waitingRef.current.shift() ?? null)
    },
    [show]
  )
  const prune = useCallback(
    (installedKeys: ReadonlySet<string>) => {
      waitingRef.current = waitingRef.current.filter((key) => installedKeys.has(key))
      if (currentRef.current && !installedKeys.has(currentRef.current)) {
        show(null)
      }
    },
    [show]
  )
  const clear = useCallback(() => {
    waitingRef.current = []
    show(null)
  }, [show])
  const pause = useCallback(() => show(null), [show])
  return { reviewKey, show, enqueue, advance, prune, pause, clear }
}
