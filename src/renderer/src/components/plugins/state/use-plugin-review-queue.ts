import { useCallback, useRef, useState } from 'react'
import type { PluginHostListEntry } from '../../../../../preload/api-types'
import { pluginNeedsReview } from '../presentation/plugin-status-presentation'

/**
 * Which plugin's review is open, plus the ones waiting behind it (an Update all that left several
 * needing review). A decision opens the next review; navigation away pauses the sequence.
 */
export function usePluginReviewQueue(): {
  reviewKey: string | null
  /** Queue advances replace the completed review in page history. */
  replacePage: boolean
  /** Opens this review now (or pauses with null), keeping any undecided review queued. */
  show: (pluginKey: string | null) => void
  enqueue: (pluginKeys: readonly string[]) => void
  /** Only a decision for the current review opens the next waiting review. */
  advance: (pluginKey: string, plugins: readonly PluginHostListEntry[]) => void
  /** Drops reviews for plugins no longer installed. */
  prune: (installedKeys: ReadonlySet<string>) => void
  /** Leaving a review pauses it; visiting a queued plugin resumes its review. */
  navigate: (pluginKey: string | null) => void
  /** Pauses the current review without dropping it from the queue. */
  pause: () => void
  clear: () => void
} {
  const [{ reviewKey, replacePage }, setReview] = useState<{
    reviewKey: string | null
    replacePage: boolean
  }>({ reviewKey: null, replacePage: false })
  const currentRef = useRef<string | null>(null)
  const waitingRef = useRef<string[]>([])

  const setCurrentReview = useCallback((pluginKey: string | null, replacePage = false) => {
    currentRef.current = pluginKey
    setReview({ reviewKey: pluginKey, replacePage })
  }, [])
  const show = useCallback(
    (pluginKey: string | null) => {
      const current = currentRef.current
      if (current === pluginKey) {
        return
      }
      if (current) {
        waitingRef.current.unshift(current)
      }
      waitingRef.current = waitingRef.current.filter((key) => key !== pluginKey)
      setCurrentReview(pluginKey)
    },
    [setCurrentReview]
  )
  const enqueue = useCallback(
    (pluginKeys: readonly string[]) => {
      const fresh = pluginKeys.filter(
        (key) => key !== currentRef.current && !waitingRef.current.includes(key)
      )
      waitingRef.current.push(...fresh)
      if (currentRef.current === null) {
        setCurrentReview(waitingRef.current.shift() ?? null)
      }
    },
    [setCurrentReview]
  )
  const advance = useCallback(
    (pluginKey: string, plugins: readonly PluginHostListEntry[]) => {
      if (currentRef.current !== pluginKey) {
        return
      }
      const needing = new Set(plugins.filter(pluginNeedsReview).map((plugin) => plugin.pluginKey))
      waitingRef.current = waitingRef.current.filter((key) => needing.has(key))
      setCurrentReview(waitingRef.current.shift() ?? null, true)
    },
    [setCurrentReview]
  )
  const prune = useCallback(
    (installedKeys: ReadonlySet<string>) => {
      waitingRef.current = waitingRef.current.filter((key) => installedKeys.has(key))
      if (currentRef.current && !installedKeys.has(currentRef.current)) {
        setCurrentReview(null)
      }
    },
    [setCurrentReview]
  )
  const clear = useCallback(() => {
    waitingRef.current = []
    setCurrentReview(null)
  }, [setCurrentReview])
  const navigate = useCallback(
    (pluginKey: string | null) => {
      if (currentRef.current !== pluginKey) {
        show(pluginKey && waitingRef.current.includes(pluginKey) ? pluginKey : null)
      }
    },
    [show]
  )
  const pause = useCallback(() => show(null), [show])
  return { reviewKey, replacePage, show, enqueue, advance, prune, navigate, pause, clear }
}
