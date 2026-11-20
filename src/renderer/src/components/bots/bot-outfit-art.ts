// Each outfit's art, read the first time a picture wears it: baked bitmaps are a few hundred KB per
// outfit, too much to ship with the page for an outfit a user may never pick.
import { useSyncExternalStore } from 'react'
import type { BotMascotId } from '../../../../shared/bot-avatar'
import type { BotAvatarOutfit } from '../../../../shared/bots/bot-avatar-outfit'

/** One mascot's outfit. Its art is a bitmap baked from the vector art with its soft shading, so drawing
 *  it needs no SVG filter; an outfit that changes the face (the eyes looking down) also carries that face
 *  and the body lines it no longer draws. */
export type BotOutfitLayer = {
  /** Base64 WebP. */
  art: string
  /** Where the art sits on the 128 px tile: x, y, width, height. */
  at: readonly [number, number, number, number]
  face?: string
  /** Path data swapped in the mascot's body (not its defs): [from, to]. */
  redraw?: readonly (readonly [string, string])[]
}

type OutfitLayers = Partial<Record<BotMascotId, BotOutfitLayer>>

const READERS = import.meta.glob<OutfitLayers>('../../../../shared/bot-mascots/outfits/*.json', {
  import: 'default'
})

const outfits = new Map<BotAvatarOutfit, OutfitLayers>()
const reading = new Set<BotAvatarOutfit>()
const listeners = new Set<() => void>()
let version = 0

function read(outfit: BotAvatarOutfit): void {
  const reader = READERS[`../../../../shared/bot-mascots/outfits/${outfit}.json`]
  if (!reader || reading.has(outfit)) {
    return
  }
  reading.add(outfit)
  reader().then(
    (layers) => {
      outfits.set(outfit, layers)
      version += 1
      for (const listener of listeners) {
        listener()
      }
    },
    // A failed read is tried again the next time the outfit is asked for.
    () => reading.delete(outfit)
  )
}

/** `id`'s layer of `outfit`; undefined while the outfit is being read, which this starts. */
export function botOutfitLayer(
  outfit: BotAvatarOutfit,
  id: BotMascotId
): BotOutfitLayer | null | undefined {
  const layers = outfits.get(outfit)
  if (!layers) {
    read(outfit)
    return undefined
  }
  return layers[id] ?? null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Renders again each time another outfit's art arrives. */
export function useBotOutfitArtArrivals(): number {
  return useSyncExternalStore(subscribe, () => version)
}
