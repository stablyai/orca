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
import { useBotOutfitLayers, type BotOutfitLayer, type BotOutfitLayers } from './bot-outfit-art'

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

/** The SVG wearing `outfit` in one picture: its face, then its art drawn over it. */
export function dressMascotSvg(svg: string, outfit: BotOutfitLayer): string {
  const [x, y, width, height] = outfit.at
  const art = `<image href="${artSrc(outfit)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none"/>`
  return `${faceMascotSvg(svg, outfit).slice(0, -'</svg>'.length)}${art}</svg>`
}

function artSrc(outfit: BotOutfitLayer): string {
  return `data:image/webp;base64,${outfit.art}`
}

/** An outfit's art as its own image over the picture, at x, y, width, height of the 128 px tile. */
export type BotOutfitArt = { src: string; at: readonly [number, number, number, number] }

/** A mascot's picture in two layers, so a new tile color redraws only the mascot, never the outfit's art. */
export type BotMascotLook = { src: string; outfit: BotOutfitArt | null }

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

const dressed = new Map<string, string>()
const faced = new Map<string, string>()
const arts = new Map<string, BotOutfitArt>()

function mascotSvg(id: BotMascotId, color: string | null): string | null {
  const svg = MASCOT_SVGS[`../../../../shared/bot-mascots/${id}.svg`]
  return svg && color ? recolorMascotSvg(svg, color) : (svg ?? null)
}

function svgSrc(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

// `layers` undefined: the outfit's art hasn't arrived, so the picture shows without it (and isn't cached).
function dressedSrc(
  id: BotMascotId,
  color: string | null,
  outfit: BotAvatarOutfit | null,
  layers: BotOutfitLayers | null | undefined
): string {
  const svg = mascotSvg(id, color)
  if (!svg) {
    return BOT_MASCOT_URLS[id]
  }
  const layer = outfit && layers ? layers[id] : undefined
  if (outfit && layers === undefined) {
    return color ? svgSrc(svg) : BOT_MASCOT_URLS[id]
  }
  return cached(dressed, `${id}|${color ?? ''}|${outfit ?? ''}`, () =>
    svgSrc(layer ? dressMascotSvg(svg, layer) : svg)
  )
}

function layeredLook(
  id: BotMascotId,
  color: string | null,
  outfit: BotAvatarOutfit | null,
  layers: BotOutfitLayers | null | undefined
): BotMascotLook {
  const layer = outfit && layers ? layers[id] : undefined
  const svg = mascotSvg(id, color)
  if (!svg) {
    return { src: BOT_MASCOT_URLS[id], outfit: null }
  }
  if (!layer) {
    return {
      src: color ? cached(faced, `${id}|${color}|`, () => svgSrc(svg)) : BOT_MASCOT_URLS[id],
      outfit: null
    }
  }
  // Only an outfit that changes the face makes the mascot's own picture differ from the plain one.
  const src = layer.face
    ? cached(faced, `${id}|${color ?? ''}|${outfit}`, () => svgSrc(faceMascotSvg(svg, layer)))
    : color
      ? cached(faced, `${id}|${color}|`, () => svgSrc(svg))
      : BOT_MASCOT_URLS[id]
  const art = cached(arts, `${id}|${outfit}`, () => ({ src: artSrc(layer), at: layer.at }))
  return { src, outfit: art }
}

function tileColor(color: string | null | undefined): string | null {
  return !color || color === DEFAULT_BOT_AVATAR_COLOR ? null : color
}

/** One mascot's picture on `color`, wearing `outfit`, as one image (for places that draw a single picture). */
export function useBotMascotSrc(
  id: BotMascotId | null,
  color: string | null | undefined,
  outfit: BotAvatarOutfit | null | undefined = null
): string | null {
  const worn = outfit ?? null
  const layers = useBotOutfitLayers(id ? worn : null)
  const tile = tileColor(color)
  if (!id) {
    return null
  }
  return tile || worn ? dressedSrc(id, tile, worn, layers) : BOT_MASCOT_URLS[id]
}

/** Each mascot's picture on `color`, wearing `outfit`, in layers: for the picker, where the color is dragged. */
export function useBotMascotLooks(
  color: string | null | undefined,
  outfit: BotAvatarOutfit | null | undefined = null
): (id: BotMascotId) => BotMascotLook {
  const worn = outfit ?? null
  const layers = useBotOutfitLayers(worn)
  const tile = tileColor(color)
  return (id) => layeredLook(id, tile, worn, layers)
}

/** One mascot's picture in layers, as useBotMascotLooks draws it. */
export function useBotMascotLook(
  id: BotMascotId,
  color: string | null | undefined,
  outfit: BotAvatarOutfit | null | undefined = null
): BotMascotLook {
  return useBotMascotLooks(color, outfit)(id)
}
