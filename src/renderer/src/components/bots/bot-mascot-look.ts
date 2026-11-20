// A mascot as a bot shows it: its SVG on the bot's tile color (on a dark color, with the light rim) and wearing
// its outfit. The SVGs ship with the page, so a new color is built in the same render; an outfit's art is read
// the first time it is worn, and the picture shows the mascot without it until then.
import type { BotMascotId } from '../../../../shared/bot-avatar'
import {
  DEFAULT_BOT_AVATAR_COLOR,
  isDarkBotAvatarColor
} from '../../../../shared/bots/bot-avatar-color'
import type { BotAvatarOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { BOT_MASCOT_URLS } from './bot-mascots'
import {
  useBotOutfitLargeArt,
  useBotOutfitLayers,
  type BotOutfitLargeArt,
  type BotOutfitLayer,
  type BotOutfitLayers
} from './bot-outfit-art'

const MASCOT_SVGS = import.meta.glob<string>('../../../../shared/bot-mascots/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true
})

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

/** The SVG wearing `outfit` in one picture: its face, then its art (base64 WebP) drawn over it. */
export function dressMascotSvg(svg: string, outfit: BotOutfitLayer, art = outfit.art): string {
  const [x, y, width, height] = outfit.at
  const image = `<image href="${artSrc(art)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none"/>`
  return `${faceMascotSvg(svg, outfit).slice(0, -'</svg>'.length)}${image}</svg>`
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

/** A picker tile's layers: the mascot as its bitmap on the tile color, unless the outfit redraws its face
 *  (the eyes looking down), which only `facedSrc` shows; then the outfit's art over it. */
export type BotMascotTileLook = { facedSrc: string | null; outfit: BotOutfitArt | null }

// Bounded, since dragging the custom color makes a new one per step; an evicted entry is rebuilt on its next read.
const MAX_CACHED = 300

function cached<T>(cache: Map<string, T>, key: string, build: () => T): T {
  const hit = cache.get(key)
  if (hit !== undefined) {
    return hit
  }
  const value = build()
  cache.set(key, value)
  const oldest = cache.keys().next()
  if (cache.size > MAX_CACHED && !oldest.done) {
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
  color: string | null,
  key: string,
  build: (svg: string) => string
): string {
  return cached(pictures, `${id}|${color ?? ''}|${key}`, () => {
    const svg = MASCOT_SVGS[`../../../../shared/bot-mascots/${id}.svg`]
    return svg ? svgSrc(build(color ? recolorMascotSvg(svg, color) : svg)) : BOT_MASCOT_URLS[id]
  })
}

function plainSrc(id: BotMascotId, color: string | null): string {
  return color ? pictureSrc(id, color, '', (svg) => svg) : BOT_MASCOT_URLS[id]
}

// The art a picture of `size` draws: the large bake once it has arrived, the small one until then.
function outfitArt(
  id: BotMascotId,
  layer: BotOutfitLayer,
  largeArt: BotOutfitLargeArt | null | undefined
): { art: string; size: BotPictureSize } {
  const large = largeArt?.[id]
  return large ? { art: large, size: 'large' } : { art: layer.art, size: 'small' }
}

// `layers` undefined: the outfit's art hasn't arrived (or failed), so the plain picture shows meanwhile.
function dressedSrc(
  id: BotMascotId,
  color: string | null,
  outfit: BotAvatarOutfit | null,
  layers: BotOutfitLayers | null | undefined,
  largeArt: BotOutfitLargeArt | null | undefined
): string {
  const layer = outfit && layers ? layers[id] : undefined
  if (!layer) {
    return plainSrc(id, color)
  }
  const { art, size } = outfitArt(id, layer, largeArt)
  return pictureSrc(id, color, `${outfit}|dressed|${size}`, (svg) =>
    dressMascotSvg(svg, layer, art)
  )
}

// No mascot SVG is built here unless the outfit redraws the face, so dragging the color builds none.
function tileLook(
  id: BotMascotId,
  color: string | null,
  outfit: BotAvatarOutfit | null,
  layers: BotOutfitLayers | null | undefined,
  largeArt: BotOutfitLargeArt | null | undefined
): BotMascotTileLook {
  const layer = outfit && layers ? layers[id] : undefined
  if (!layer) {
    return { facedSrc: null, outfit: null }
  }
  const facedSrc = layer.face
    ? pictureSrc(id, color, `${outfit}|faced`, (svg) => faceMascotSvg(svg, layer))
    : null
  const { art, size } = outfitArt(id, layer, largeArt)
  const image = cached(arts, `${id}|${outfit}|${size}`, () => ({ src: artSrc(art), at: layer.at }))
  return { facedSrc, outfit: image }
}

function tileColor(color: string | null | undefined): string | null {
  return !color || color === DEFAULT_BOT_AVATAR_COLOR ? null : color
}

/** One mascot's picture on `color`, wearing `outfit`, as one image (for places that draw a single picture). */
export function useBotMascotSrc(
  id: BotMascotId | null,
  color: string | null | undefined,
  outfit: BotAvatarOutfit | null | undefined = null,
  size: BotPictureSize = 'small'
): string | null {
  const worn = id ? (outfit ?? null) : null
  const layers = useBotOutfitLayers(worn)
  const largeArt = useBotOutfitLargeArt(worn, size === 'large')
  const tile = tileColor(color)
  if (!id) {
    return null
  }
  return dressedSrc(id, tile, worn, layers, largeArt)
}

/** Each mascot's tile layers on `color`, wearing `outfit`: for the picker, where the color is dragged. */
export function useBotMascotTileLooks(
  color: string | null | undefined,
  outfit: BotAvatarOutfit | null | undefined = null,
  size: BotPictureSize = 'small'
): (id: BotMascotId) => BotMascotTileLook {
  const worn = outfit ?? null
  const layers = useBotOutfitLayers(worn)
  const largeArt = useBotOutfitLargeArt(worn, size === 'large')
  const tile = tileColor(color)
  return (id) => tileLook(id, tile, worn, layers, largeArt)
}

/** One mascot's picture in layers, its SVG on `color` with the outfit's art apart from it. */
export function useBotMascotLook(
  id: BotMascotId,
  color: string | null | undefined,
  outfit: BotAvatarOutfit | null | undefined = null,
  size: BotPictureSize = 'small'
): BotMascotLook {
  const tile = tileColor(color)
  const look = useBotMascotTileLooks(color, outfit, size)(id)
  return { src: look.facedSrc ?? plainSrc(id, tile), outfit: look.outfit }
}
