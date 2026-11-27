// A mascot as a bot shows it: its SVG on the bot's tile color (on a dark color, with the light rim) and wearing
// its outfit. Mascot SVGs are fetched on demand from their asset URLs only when recoloring or redrawing a face,
// keeping the ~250 KB raw SVG set out of the initial renderer boot bundle.
import { useSyncExternalStore } from 'react'
import { BOT_MASCOT_IDS, type BotMascotId } from '../../../../shared/bot-avatar'
import {
  DEFAULT_BOT_AVATAR_COLOR,
  isDarkBotAvatarColor
} from '../../../../shared/bots/bot-avatar-color'
import { BOT_AVATAR_OUTFITS, type BotAvatarOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { BOT_MASCOT_URLS } from './bot-mascots'
import {
  useBotOutfitLargeArt,
  useBotOutfitLayers,
  type BotOutfitLargeArt,
  type BotOutfitLayer,
  type BotOutfitLayers
} from './bot-outfit-art'

type MascotSvgEntry = {
  value: string | undefined
  pending: Promise<string | null> | null
  listeners: Set<() => void>
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => string | undefined
}

const mascotSvgEntries = new Map<BotMascotId, MascotSvgEntry>()

function mascotSvgEntry(id: BotMascotId): MascotSvgEntry {
  let entry = mascotSvgEntries.get(id)
  if (!entry) {
    const listeners = new Set<() => void>()
    const created: MascotSvgEntry = {
      value: undefined,
      pending: null,
      listeners,
      subscribe: (listener) => {
        listeners.add(listener)
        if (created.value === undefined) {
          void loadRawMascotSvg(id)
        }
        return () => {
          listeners.delete(listener)
        }
      },
      getSnapshot: () => created.value
    }
    entry = created
    mascotSvgEntries.set(id, entry)
  }
  return entry
}

function loadRawMascotSvg(id: BotMascotId): Promise<string | null> {
  const entry = mascotSvgEntry(id)
  if (entry.value !== undefined) {
    return Promise.resolve(entry.value)
  }
  if (!entry.pending) {
    const url = BOT_MASCOT_URLS[id]
    entry.pending = fetch(url)
      .then((res) => (res.ok ? res.text() : null))
      .catch(() => null)
      .then((svg) => {
        entry.pending = null
        if (svg) {
          entry.value = svg
          for (const listener of entry.listeners) {
            listener()
          }
        }
        return svg
      })
  }
  return entry.pending
}

const NOOP_SUBSCRIBE = () => () => {}
const NO_SVG = () => undefined

function useRawMascotSvg(id: BotMascotId | null, needed: boolean): string | undefined {
  const entry = id && needed ? mascotSvgEntry(id) : null
  return useSyncExternalStore(
    entry ? entry.subscribe : NOOP_SUBSCRIBE,
    entry ? entry.getSnapshot : NO_SVG,
    NO_SVG
  )
}

/** The SVG drawn on `color`; the mascots read their background and rim from these defaults. */
export function recolorMascotSvg(svg: string, color: string): string {
  const filled = svg.replace(`var(--avatar-bg,${DEFAULT_BOT_AVATAR_COLOR})`, color)
  return isDarkBotAvatarColor(color) ? filled.replace('var(--avatar-rim,0)', '1') : filled
}

// Every mascot SVG opens with its defs and ends with its face group, then the groups that place it.
const DEFS_CLOSE = '</defs>'
const FACE_OPEN = '<g id="face">'
const FACE_TAIL = '</g></g></g></svg>'

function redrawBody(svg: string, redraw: BotOutfitLayer['redraw']): string {
  const bodyAt = svg.indexOf(DEFS_CLOSE)
  if (!redraw?.length || bodyAt === -1) {
    return svg
  }
  let body = svg.slice(bodyAt)
  for (const [from, to] of redraw) {
    body = body.replaceAll(`d="${from}"`, `d="${to}"`)
  }
  return svg.slice(0, bodyAt) + body
}

/** The SVG with the outfit's face and body lines, when it has them (the eyes looking down). */
export function faceMascotSvg(svg: string, outfit: BotOutfitLayer): string {
  const trimmed = svg.trimEnd()
  const faceAt = trimmed.indexOf(FACE_OPEN)
  return outfit.face && faceAt !== -1 && trimmed.endsWith(FACE_TAIL)
    ? `${redrawBody(trimmed.slice(0, faceAt), outfit.redraw)}${FACE_OPEN}${outfit.face}${FACE_TAIL}`
    : trimmed
}

/** The mascot's SVG on `color` (null: its own sky blue), with the face `outfit` redraws, if any. */
export async function readBotMascotSvg(
  id: BotMascotId,
  color: string | null,
  outfit?: BotOutfitLayer
): Promise<string | null> {
  const svg = await loadRawMascotSvg(id)
  if (!svg) {
    return null
  }
  const tiled = color ? recolorMascotSvg(svg, color) : svg
  return outfit ? faceMascotSvg(tiled, outfit) : tiled
}

function artSrc(art: string): string {
  return `data:image/webp;base64,${art}`
}

/** Which bake of an outfit's art a picture draws: small for a sidebar row or chat (up to about 48 px),
 *  large for the picker and other big pictures. */
export type BotPictureSize = 'small' | 'large'

/** An outfit's art as its own image over the picture, at x, y, width, height of the 128 px tile. */
export type BotOutfitArt = { src: string; at: readonly [number, number, number, number] }

/** A mascot's picture in two layers, so a new tile color redraws only the mascot, never the outfit's art. */
export type BotMascotLook = { src: string; outfit: BotOutfitArt | null }

/** A picker tile's layers: the mascot's bitmap on the tile color (`face`, the bitmap of the mascot the
 *  outfit redraws, the eyes looking down), then the outfit's art over it. */
export type BotMascotTileLook = { face: string | null; outfit: BotOutfitArt | null }

// Bounded, since dragging the custom color makes a new one per step; an evicted entry is rebuilt on its next read.
const MAX_CACHED = 300
// One per mascot, outfit and size: an outfit's art is never built twice.
const MAX_OUTFIT_ART = BOT_MASCOT_IDS.length * BOT_AVATAR_OUTFITS.length * 2

function cached<T>(cache: Map<string, T>, key: string, build: () => T, max = MAX_CACHED): T {
  const hit = cache.get(key)
  if (hit !== undefined) {
    return hit
  }
  const value = build()
  cache.set(key, value)
  const oldest = cache.keys().next()
  if (cache.size > max && !oldest.done) {
    cache.delete(oldest.value)
  }
  return value
}

const pictures = new Map<string, string>()
const arts = new Map<string, BotOutfitArt>()

function svgSrc(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

// Each picture is built once per mascot, color and outfit, inside the cache miss.
function pictureSrc(
  id: BotMascotId,
  rawSvg: string | undefined,
  color: string | null,
  key: string,
  build: (svg: string) => string
): string {
  if (!rawSvg) {
    return BOT_MASCOT_URLS[id]
  }
  return cached(pictures, `${id}|${color ?? ''}|${key}`, () =>
    svgSrc(build(color ? recolorMascotSvg(rawSvg, color) : rawSvg))
  )
}

function plainSrc(id: BotMascotId, rawSvg: string | undefined, color: string | null): string {
  return color ? pictureSrc(id, rawSvg, color, '', (svg) => svg) : BOT_MASCOT_URLS[id]
}

// What `id` wears at `size`. A large picture wears nothing until its large art has arrived, so it never
// shows the small bake scaled up; then its whole look (art and any face) appears at once.
function wornLayer(
  id: BotMascotId,
  outfit: BotAvatarOutfit | null,
  layers: BotOutfitLayers | null | undefined,
  largeArt: BotOutfitLargeArt | null | undefined,
  size: BotPictureSize
): BotOutfitLayer | undefined {
  const layer = outfit && layers ? layers[id] : undefined
  return size === 'large' && !largeArt?.[id] ? undefined : layer
}

const faces = new Map<string, string>()

// No mascot SVG is built here, so dragging the color builds none and the picker draws no SVG blur.
function tileLook(
  id: BotMascotId,
  outfit: BotAvatarOutfit | null,
  layers: BotOutfitLayers | null | undefined,
  largeArt: BotOutfitLargeArt | null | undefined,
  size: BotPictureSize
): BotMascotTileLook {
  const layer = wornLayer(id, outfit, layers, largeArt, size)
  if (!layer) {
    return { face: null, outfit: null }
  }
  const large = size === 'large' ? largeArt?.[id] : undefined
  const image = cached(
    arts,
    `${id}|${outfit}|${size}`,
    () => ({ src: artSrc(large ? large.art : layer.art), at: layer.at }),
    MAX_OUTFIT_ART
  )
  const faceArt = large ? large.faceArt : layer.faceArt
  const face = faceArt
    ? cached(faces, `${id}|${outfit}|${size}`, () => artSrc(faceArt), MAX_OUTFIT_ART)
    : null
  return { face, outfit: image }
}

function tileColor(color: string | null | undefined): string | null {
  return !color || color === DEFAULT_BOT_AVATAR_COLOR ? null : color
}

/** Each mascot's tile layers wearing `outfit`, apart from the tile color: for the picker, where the
 *  color is dragged. */
export function useBotMascotTileLooks(
  outfit: BotAvatarOutfit | null | undefined = null,
  size: BotPictureSize = 'small'
): (id: BotMascotId) => BotMascotTileLook {
  const worn = outfit ?? null
  const layers = useBotOutfitLayers(worn)
  const largeArt = useBotOutfitLargeArt(worn, size === 'large')
  return (id) => tileLook(id, worn, layers, largeArt, size)
}

/** One mascot's picture in layers, its SVG on `color` with the outfit's art apart from it: the art
 *  decodes as its own image, which costs a sidebar of avatars far less than art drawn inside the SVG. */
export function useBotMascotLayers(
  id: BotMascotId | null,
  color: string | null | undefined,
  outfit: BotAvatarOutfit | null | undefined = null,
  size: BotPictureSize = 'small'
): BotMascotLook | null {
  const worn = id ? (outfit ?? null) : null
  const layers = useBotOutfitLayers(worn)
  const largeArt = useBotOutfitLargeArt(worn, size === 'large')
  const tile = tileColor(color)
  const layer = id ? wornLayer(id, worn, layers, largeArt, size) : undefined
  const rawSvg = useRawMascotSvg(id, Boolean(tile || layer?.face))
  if (!id) {
    return null
  }
  const src = layer?.face
    ? pictureSrc(id, rawSvg, tile, `${worn}|faced`, (svg) => faceMascotSvg(svg, layer))
    : plainSrc(id, rawSvg, tile)
  return { src, outfit: tileLook(id, worn, layers, largeArt, size).outfit }
}

/** useBotMascotLayers for a mascot that is always there. */
export function useBotMascotLook(
  id: BotMascotId,
  color: string | null | undefined,
  outfit: BotAvatarOutfit | null | undefined = null,
  size: BotPictureSize = 'small'
): BotMascotLook {
  return (
    useBotMascotLayers(id, color, outfit, size) ?? {
      src: BOT_MASCOT_URLS[id],
      outfit: null
    }
  )
}
