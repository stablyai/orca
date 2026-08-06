import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CustomPet } from '../../../../shared/types'
import { applyCodexSpriteTimingDefaults } from '../../../../shared/codex-pet-sprite-defaults'
import { useAppStore } from '../../store'
import { BUNDLED_PET, findBundledPet, isBundledPetId } from './pet-models'
import {
  detectedSpriteCache,
  loadCustomBlobUrl,
  peekCustomPetBlobUrl,
  readCustomPetBlobUrl,
  retainCustomPetBlobCacheEntry,
  type DetectedSpriteCacheEntry
} from './pet-blob-cache'

// Re-export so existing callers (the store slice) that point at this module
// keep working without knowing about the cache module split.
export { revokeCustomPetBlobUrl } from './pet-blob-cache'

export type ResolvedPet =
  | { url: string; ready: boolean; sprite: null; detected: null }
  | {
      url: string
      ready: boolean
      sprite: NonNullable<CustomPet['sprite']>
      detected: null
    }
  | { url: string; ready: boolean; sprite: null; detected: DetectedSpriteCacheEntry }

/** Resolve the active pet to a URL the overlay can render.
 *
 *  For bundled pets this is synchronous. For custom ones we issue an
 *  IPC read and build a blob: URL with the correct MIME; until that resolves,
 *  we fall back to the bundled default so the overlay is never empty.
 */
export function usePetUrl(): ResolvedPet {
  const petId = useAppStore((s) => s.petId)
  const customPets = useAppStore((s) => s.customPets)
  const bundled = isBundledPetId(petId)
  const customMeta = bundled ? null : customPets.find((m) => m.id === petId)

  const [customUrl, setCustomUrl] = useState<string | null>(() =>
    customMeta ? peekCustomPetBlobUrl(customMeta.id) : null
  )
  // Why: track the last id we started loading so a rapid switch between
  // custom pets doesn't let a slower earlier response clobber the newer
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
  useLayoutEffect(() => {
    if (!customId) {
      return
    }
    // Why: cancelled older loads may finish after the active pet. Pin the
    // committed URL/bitmaps so their cache insertion cannot evict active media.
    return retainCustomPetBlobCacheEntry(customId)
  }, [customId])
  useEffect(() => {
    if (!customId || !customFileName) {
      setCustomUrl(null)
      return
    }
    const cached = readCustomPetBlobUrl(customId)
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
    const pet = findBundledPet(petId) ?? BUNDLED_PET
    return { url: pet.url, ready: true, sprite: null, detected: null }
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
      // Why: sprites persisted before per-frame durations existed pace ~9x too
      // fast. Upgrade the legacy Codex fingerprint without forcing a re-import.
      return {
        url: customUrl,
        ready: true,
        sprite: applyCodexSpriteTimingDefaults(customMeta.sprite),
        detected: null
      }
    }
    const detected = detectedSpriteCache.get(customMeta.id)
    if (detected) {
      return { url: customUrl, ready: true, sprite: null, detected }
    }
    return { url: customUrl, ready: true, sprite: null, detected: null }
  }
  return { url: BUNDLED_PET.url, ready: false, sprite: null, detected: null }
}
