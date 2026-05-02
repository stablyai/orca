import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { BUNDLED_SIDEKICK, findBundledSidekick, isBundledSidekickId } from './sidekick-models'
import { blobUrlCache, loadCustomBlobUrl } from './sidekick-blob-cache'

// Re-export so existing callers (the store slice) that point at this module
// keep working without knowing about the cache module split.
export { revokeCustomSidekickBlobUrl } from './sidekick-blob-cache'

/** Resolve the active sidekick to a URL the overlay can render.
 *
 *  For bundled sidekicks this is synchronous. For custom ones we issue an
 *  IPC read and build a blob: URL with the correct MIME; until that resolves,
 *  we fall back to the bundled default so the overlay is never empty.
 */
export function useSidekickUrl(): { url: string; ready: boolean } {
  const sidekickId = useAppStore((s) => s.sidekickId)
  const customSidekicks = useAppStore((s) => s.customSidekicks)
  const bundled = isBundledSidekickId(sidekickId)
  const customMeta = bundled ? null : customSidekicks.find((m) => m.id === sidekickId)

  const [customUrl, setCustomUrl] = useState<string | null>(() =>
    customMeta ? (blobUrlCache.get(customMeta.id) ?? null) : null
  )
  // Why: track the last id we started loading so a rapid switch between
  // custom sidekicks doesn't let a slower earlier response clobber the newer
  // state.
  const pendingRef = useRef<string | null>(null)

  const customId = customMeta?.id ?? null
  const customFileName = customMeta?.fileName ?? null
  const customMime = customMeta?.mimeType ?? 'image/png'
  useEffect(() => {
    if (!customId || !customFileName) {
      setCustomUrl(null)
      return
    }
    const cached = blobUrlCache.get(customId)
    if (cached) {
      setCustomUrl(cached)
      return
    }
    // Why: clear the previous custom blob URL before awaiting the new one so
    // the hook's fallback-to-bundled branch kicks in during the load window.
    setCustomUrl(null)
    pendingRef.current = customId
    let cancelled = false
    void loadCustomBlobUrl(customId, customFileName, customMime).then((url) => {
      if (cancelled || pendingRef.current !== customId) {
        return
      }
      setCustomUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [customId, customFileName, customMime])

  if (bundled) {
    const sidekick = findBundledSidekick(sidekickId) ?? BUNDLED_SIDEKICK
    return { url: sidekick.url, ready: true }
  }
  if (customMeta && customUrl) {
    return { url: customUrl, ready: true }
  }
  // Fallback: while a custom blob URL is loading (or if the custom sidekick is
  // missing entirely), render the bundled default so the overlay doesn't
  // flash empty.
  return { url: BUNDLED_SIDEKICK.url, ready: false }
}
