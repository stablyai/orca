import { useEffect, useRef, useState } from 'react'
import type { CustomSidekick } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { BUNDLED_SIDEKICK, findBundledSidekick, isBundledSidekickId } from './sidekick-models'
import {
  blobUrlCache,
  detectedSpriteCache,
  loadCustomBlobUrl,
  type DetectedSpriteCacheEntry
} from './sidekick-blob-cache'

// Re-export so existing callers (the store slice) that point at this module
// keep working without knowing about the cache module split.
export { revokeCustomSidekickBlobUrl } from './sidekick-blob-cache'

export type ResolvedSidekick =
  | { url: string; ready: boolean; sprite: null; detected: null }
  | {
      url: string
      ready: boolean
      sprite: NonNullable<CustomSidekick['sprite']>
      detected: null
    }
  | { url: string; ready: boolean; sprite: null; detected: DetectedSpriteCacheEntry }

/** Resolve the active sidekick to a URL the overlay can render.
 *
 *  For bundled sidekicks this is synchronous. For custom ones we issue an
 *  IPC read and build a blob: URL with the correct MIME; until that resolves,
 *  we fall back to the bundled default so the overlay is never empty.
 */
export function useSidekickUrl(): ResolvedSidekick {
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
  const customKind = customMeta?.kind ?? 'image'
  // Why: prefer manifest fps captured at import time; sprite-with-frame entries
  // store fps on `sprite`, frame-less bundles carry it on `spriteFps`.
  const customSpriteFps = customMeta?.sprite?.fps ?? customMeta?.spriteFps
  // Why: when the manifest already declares a valid sprite layout, the
  // overlay reads the `sprite` branch and never touches detectedSpriteCache,
  // so we skip auto-detection in the cache loader to avoid leaking ImageBitmaps.
  const customHasManifestSprite =
    !!customMeta?.sprite &&
    customMeta.sprite.frameWidth > 0 &&
    customMeta.sprite.frameHeight > 0 &&
    customMeta.sprite.fps > 0
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
    void loadCustomBlobUrl(
      customId,
      customFileName,
      customMime,
      customKind,
      customSpriteFps,
      customHasManifestSprite
    ).then((url) => {
      if (cancelled || pendingRef.current !== customId) {
        return
      }
      setCustomUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [customId, customFileName, customMime, customKind, customSpriteFps, customHasManifestSprite])

  if (bundled) {
    const sidekick = findBundledSidekick(sidekickId) ?? BUNDLED_SIDEKICK
    return { url: sidekick.url, ready: true, sprite: null, detected: null }
  }
  if (customMeta && customUrl) {
    // Why: guard against manifest entries with zero/negative dims or fps —
    // those would break the overlay's frame math, so fall through to detection.
    if (
      customMeta.sprite &&
      customMeta.sprite.frameWidth > 0 &&
      customMeta.sprite.frameHeight > 0 &&
      customMeta.sprite.fps > 0
    ) {
      return { url: customUrl, ready: true, sprite: customMeta.sprite, detected: null }
    }
    const detected = detectedSpriteCache.get(customMeta.id)
    if (detected) {
      return { url: customUrl, ready: true, sprite: null, detected }
    }
    return { url: customUrl, ready: true, sprite: null, detected: null }
  }
  return { url: BUNDLED_SIDEKICK.url, ready: false, sprite: null, detected: null }
}
