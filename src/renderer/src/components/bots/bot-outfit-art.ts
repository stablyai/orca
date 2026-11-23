// Each outfit's art, read the first time a picture wears it. Small art (for sidebar rows and other small
// pictures) comes with the outfit; the large art only a big picture reads. Both are baked bitmaps, too much
// to ship with the page for an outfit a user may never pick.
import { useSyncExternalStore } from 'react'
import type { BotMascotId } from '../../../../shared/bot-avatar'
import type { BotAvatarOutfit } from '../../../../shared/bots/bot-avatar-outfit'

/** One mascot's outfit. Its art is a bitmap baked from the vector art with its soft shading, so drawing
 *  it needs no SVG filter; an outfit that changes the face (the eyes looking down) also carries that face
 *  and the body lines it no longer draws. */
export type BotOutfitLayer = {
  /** Base64 WebP, baked for a 96 px tile. */
  art: string
  /** Where the art sits on the 128 px tile: x, y, width, height; the large art fills the same box. */
  at: readonly [number, number, number, number]
  face?: string
  /** With `face`: the mascot it redraws, baked as a 96 px bitmap like the mascots' own, base64 WebP. */
  faceArt?: string
  /** Path data swapped in the mascot's body (not its defs): [from, to]. */
  redraw?: readonly (readonly [string, string])[]
}

export type BotOutfitLayers = Partial<Record<BotMascotId, BotOutfitLayer>>

/** Each mascot's art baked for a 384 px tile, and any redrawn mascot at 512 px, base64 WebP. */
export type BotOutfitLargeArt = Partial<Record<BotMascotId, { art: string; faceArt?: string }>>

/** One lazily read file per outfit, with the pictures waiting for it. */
type OutfitFile<T> = {
  value: T | undefined
  reading: boolean
  listeners: Set<() => void>
  subscribe: (listener: () => void) => () => void
}

const READ_RETRIES = 3
const FIRST_RETRY_MS = 250

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url}: ${String(response.status)}`)
  }
  const value: T = await response.json()
  return value
}

// Fetched as plain files, not imported as modules: the browser keeps a failed module import for the page's
// life, so a read that failed once could never be tried again and the outfit stayed blank.
export function outfitFiles<T>(
  urls: Record<string, string>,
  pathOf: (outfit: BotAvatarOutfit) => string
): (outfit: BotAvatarOutfit) => OutfitFile<T> | null {
  const files = new Map<BotAvatarOutfit, OutfitFile<T>>()
  return (outfit) => {
    const url = urls[pathOf(outfit)]
    if (!url) {
      return null
    }
    const known = files.get(outfit)
    if (known) {
      return known
    }
    let failures = 0
    const load = (): void => {
      file.reading = true
      fetchJson<T>(url).then(
        (value) => {
          file.value = value
          for (const waiting of file.listeners) {
            waiting()
          }
        },
        // A failed read is tried again soon while pictures still wait on it, a few times, and by the next
        // picture that wears the outfit.
        () => {
          file.reading = false
          failures += 1
          if (failures > READ_RETRIES) {
            // Told with no value, so a one-off read (a Slack icon) gives up instead of waiting forever.
            for (const waiting of file.listeners) {
              waiting()
            }
          } else {
            setTimeout(
              () => {
                if (file.listeners.size > 0 && file.value === undefined && !file.reading) {
                  load()
                }
              },
              FIRST_RETRY_MS * 2 ** (failures - 1)
            )
          }
        }
      )
    }
    const file: OutfitFile<T> = {
      value: undefined,
      reading: false,
      listeners: new Set(),
      subscribe: (listener) => {
        file.listeners.add(listener)
        if (file.value === undefined && !file.reading) {
          load()
        }
        return () => file.listeners.delete(listener)
      }
    }
    files.set(outfit, file)
    return file
  }
}

const layerFile = outfitFiles<BotOutfitLayers>(
  import.meta.glob<string>('../../../../shared/bot-mascots/outfits/*.json', {
    query: '?url',
    import: 'default',
    eager: true
  }),
  (outfit) => `../../../../shared/bot-mascots/outfits/${outfit}.json`
)
const largeArtFile = outfitFiles<BotOutfitLargeArt>(
  import.meta.glob<string>('../../../../shared/bot-mascots/outfits/large/*.json', {
    query: '?url',
    import: 'default',
    eager: true
  }),
  (outfit) => `../../../../shared/bot-mascots/outfits/large/${outfit}.json`
)

const NO_FILE = (): (() => void) => () => {}

function useOutfitFile<T>(file: OutfitFile<T> | null): T | null | undefined {
  return useSyncExternalStore(file ? file.subscribe : NO_FILE, () => (file ? file.value : null))
}

/** The value once read, or undefined when the read failed after its retries. */
function readOnce<T>(file: OutfitFile<T>): Promise<T | undefined> {
  if (file.value !== undefined) {
    return Promise.resolve(file.value)
  }
  return new Promise((resolve) => {
    const stop = file.subscribe(() => {
      stop()
      resolve(file.value)
    })
  })
}

/** `outfit`'s layers and large art, read now (for a picture drawn once); undefined when either read failed. */
export async function readBotOutfitArt(
  outfit: BotAvatarOutfit
): Promise<{ layers: BotOutfitLayers; large: BotOutfitLargeArt } | undefined> {
  const layers = layerFile(outfit)
  const large = largeArtFile(outfit)
  if (!layers || !large) {
    return undefined
  }
  const [layerValue, largeValue] = await Promise.all([readOnce(layers), readOnce(large)])
  return layerValue && largeValue ? { layers: layerValue, large: largeValue } : undefined
}

/** `outfit`'s layers, read when first worn: undefined until they arrive, null for no outfit. */
export function useBotOutfitLayers(
  outfit: BotAvatarOutfit | null
): BotOutfitLayers | null | undefined {
  return useOutfitFile(outfit ? layerFile(outfit) : null)
}

/** `outfit`'s large art, read only for a big picture: undefined until it arrives, null when not wanted. */
export function useBotOutfitLargeArt(
  outfit: BotAvatarOutfit | null,
  large: boolean
): BotOutfitLargeArt | null | undefined {
  return useOutfitFile(outfit && large ? largeArtFile(outfit) : null)
}
