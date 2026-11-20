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

export type BotOutfitLayers = Partial<Record<BotMascotId, BotOutfitLayer>>

const READERS = import.meta.glob<BotOutfitLayers>('../../../../shared/bot-mascots/outfits/*.json', {
  import: 'default'
})

const outfits = new Map<BotAvatarOutfit, BotOutfitLayers>()
const reading = new Set<BotAvatarOutfit>()
const listeners = new Map<BotAvatarOutfit, Set<() => void>>()
const subscribers = new Map<BotAvatarOutfit, (listener: () => void) => () => void>()

function read(outfit: BotAvatarOutfit): void {
  const reader = READERS[`../../../../shared/bot-mascots/outfits/${outfit}.json`]
  if (!reader || outfits.has(outfit) || reading.has(outfit)) {
    return
  }
  reading.add(outfit)
  reader().then(
    (layers) => {
      outfits.set(outfit, layers)
      for (const listener of listeners.get(outfit) ?? []) {
        listener()
      }
    },
    // A failed read is tried again by the next picture that wears the outfit.
    () => reading.delete(outfit)
  )
}

// One stable subscribe per outfit, so a picture listens only for the outfit it wears.
function subscriberOf(outfit: BotAvatarOutfit): (listener: () => void) => () => void {
  let subscribe = subscribers.get(outfit)
  if (!subscribe) {
    subscribe = (listener) => {
      const own = listeners.get(outfit) ?? new Set()
      listeners.set(outfit, own)
      own.add(listener)
      read(outfit)
      return () => own.delete(listener)
    }
    subscribers.set(outfit, subscribe)
  }
  return subscribe
}

const NO_OUTFIT = (): (() => void) => () => {}

/** `outfit`'s layers, read when first worn: undefined until they arrive, null for no outfit. */
export function useBotOutfitLayers(
  outfit: BotAvatarOutfit | null
): BotOutfitLayers | null | undefined {
  return useSyncExternalStore(outfit ? subscriberOf(outfit) : NO_OUTFIT, () =>
    outfit ? outfits.get(outfit) : null
  )
}
