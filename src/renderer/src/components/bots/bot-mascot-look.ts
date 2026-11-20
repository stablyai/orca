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
import { useBotOutfitLayerOf, type BotOutfitLayer, type BotOutfitLayerOf } from './bot-outfit-art'

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

/** The SVG wearing `outfit`, its face and body lines swapped first when the outfit has them. */
export function dressMascotSvg(svg: string, outfit: BotOutfitLayer): string {
  const trimmed = svg.trimEnd()
  const faceAt = trimmed.indexOf(FACE_OPEN)
  const faced =
    outfit.face && faceAt !== -1 && trimmed.endsWith(FACE_TAIL)
      ? `${redrawBody(trimmed.slice(0, faceAt), outfit.redraw)}${FACE_OPEN}${outfit.face}${FACE_TAIL}`
      : trimmed
  const [x, y, width, height] = outfit.at
  const art = `<image href="data:image/webp;base64,${outfit.art}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none"/>`
  return `${faced.slice(0, -'</svg>'.length)}${art}</svg>`
}

// Bounded, since dragging the custom color makes a new one per step; an evicted look is rebuilt on its next read.
const MAX_LOOKS = 300
const looks = new Map<string, string>()

function lookSrc(
  id: BotMascotId,
  color: string | null,
  outfit: BotAvatarOutfit | null,
  layerOf: BotOutfitLayerOf
): string {
  const key = `${id}|${color ?? ''}|${outfit ?? ''}`
  const cached = looks.get(key)
  if (cached) {
    return cached
  }
  const svg = MASCOT_SVGS[`../../../../shared/bot-mascots/${id}.svg`]
  if (!svg) {
    return BOT_MASCOT_URLS[id]
  }
  const layer = outfit ? layerOf(outfit, id) : null
  if (layer === undefined) {
    // Not cached, so the dressed look is built once the outfit's art arrives.
    return color ? svgSrc(recolorMascotSvg(svg, color)) : BOT_MASCOT_URLS[id]
  }
  const colored = color ? recolorMascotSvg(svg, color) : svg
  const src = svgSrc(layer ? dressMascotSvg(colored, layer) : colored)
  looks.set(key, src)
  const oldest = looks.keys().next()
  if (looks.size > MAX_LOOKS && !oldest.done) {
    looks.delete(oldest.value)
  }
  return src
}

function svgSrc(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Each mascot's picture on `color` and wearing `outfit`; the bundled SVG on the default look. */
export function useBotMascotSrcs(
  ids: readonly BotMascotId[],
  color: string | null | undefined,
  outfit: BotAvatarOutfit | null | undefined = null
): Record<BotMascotId, string> {
  const layerOf = useBotOutfitLayerOf()
  const tile = !color || color === DEFAULT_BOT_AVATAR_COLOR ? null : color
  const worn = outfit ?? null
  const srcs = { ...BOT_MASCOT_URLS }
  if (tile || worn) {
    for (const id of ids) {
      srcs[id] = lookSrc(id, tile, worn, layerOf)
    }
  }
  return srcs
}

/** One mascot's picture on `color`, wearing `outfit`. */
export function useBotMascotSrc(
  id: BotMascotId | null,
  color: string | null | undefined,
  outfit: BotAvatarOutfit | null | undefined = null
): string | null {
  const srcs = useBotMascotSrcs(id ? [id] : [], color, outfit)
  return id ? srcs[id] : null
}
