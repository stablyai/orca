import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CustomPet } from '../../../../shared/pet-types'
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

/** Resolve bundled media synchronously; custom IPC/blob loads temporarily fall back to the bundled default. */
export function usePetUrl(): ResolvedPet {
  const petId = useAppStore((s) => s.petId)
  const customPets = useAppStore((s) => s.customPets)
  const bundled = isBundledPetId(petId)
  const customMeta = bundled ? null : customPets.find((m) => m.id === petId)

  const [customUrl, setCustomUrl] = useState<string | null>(() =>
    customMeta ? peekCustomPetBlobUrl(customMeta.id) : null
  )
  // Ignore slower earlier loads after rapid pet switches.
  const pendingRef = useRef<string | null>(null)

  const customId = customMeta?.id ?? null
  const customFileName = customMeta?.fileName ?? null
  const customMime = customMeta?.mimeType ?? 'image/png'
  const customKind = customMeta?.kind ?? 'image'
  // Manifest playback speed lives on sprite for grids and spriteFps for frame-less bundles.
  const customSpriteFps = customMeta?.sprite?.fps ?? customMeta?.spriteFps
  // Manifest grids never consume detected bitmaps; skip detection to avoid leaking ImageBitmaps.
  const customHasManifestSprite =
    !!customMeta?.sprite &&
    customMeta.sprite.frameWidth > 0 &&
    customMeta.sprite.frameHeight > 0 &&
    customMeta.sprite.fps > 0
  useLayoutEffect(() => {
    if (!customId) {
      return
    }
    // Pin active media so late canceled loads cannot evict its URL/bitmaps.
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
    // Clear the prior URL so the bundled fallback covers the next load.
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
    // Invalid dimensions/fps break frame math; fall through to detection.
    if (
      customMeta.sprite &&
      customMeta.sprite.frameWidth > 0 &&
      customMeta.sprite.frameHeight > 0 &&
      customMeta.sprite.fps > 0
    ) {
      // Upgrade legacy Codex pacing without requiring re-import; older persisted sprites otherwise play about 9× too fast.
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
