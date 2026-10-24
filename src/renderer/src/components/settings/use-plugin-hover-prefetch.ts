import { useCallback, useEffect, useRef } from 'react'
import type { PluginMarketplaceHostListing } from '../../../../preload/api-types'
import type { PluginPagePreview } from './use-plugin-catalog'

/** Pointer rest before a hover counts as intent. */
export const PLUGIN_PREFETCH_INTENT_MS = 150
/** Previews one Settings visit may fetch on hover; each is a git checkout. */
export const PLUGIN_PREFETCH_SESSION_CAP = 12

/**
 * Reads a plugin's files before its page opens, but only on hover intent: one pending at a time
 * (the latest hover wins), cancelled when the pointer leaves, and capped per visit.
 */
export function usePluginHoverPrefetch(
  fetchPreview: (listing: PluginMarketplaceHostListing) => Promise<PluginPagePreview>
): {
  intend: (listing: PluginMarketplaceHostListing) => void
  cancel: () => void
} {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchedRef = useRef(new Set<string>())

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])
  useEffect(() => cancel, [cancel])

  const intend = useCallback(
    (listing: PluginMarketplaceHostListing) => {
      cancel()
      const key = `${listing.marketplaceSourceId}:${listing.pluginKey}:${listing.marketplaceCommit}`
      if (fetchedRef.current.has(key) || fetchedRef.current.size >= PLUGIN_PREFETCH_SESSION_CAP) {
        return
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        fetchedRef.current.add(key)
        void fetchPreview(listing)
      }, PLUGIN_PREFETCH_INTENT_MS)
    },
    [cancel, fetchPreview]
  )
  return { intend, cancel }
}
