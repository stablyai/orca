// A mascot as a bot shows it: its SVG on the bot's tile color (on a dark color, with the light rim) and wearing
// its outfit. The SVGs and outfits ship with the page, so a new look is built in the same render: no frame shows
// another color or outfit.
import type { BotMascotId } from '../../../../shared/bot-avatar'
import {
  DEFAULT_BOT_AVATAR_COLOR,
  isDarkBotAvatarColor
} from '../../../../shared/bots/bot-avatar-color'
import type { BotAvatarOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { BOT_MASCOT_URLS } from './bot-mascots'

const MASCOT_SVGS = import.meta.glob<string>('../../../../shared/bot-mascots/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true
})

/** One mascot's outfit: drawn over the picture, and for an outfit that changes the face (the eyes looking
 *  down), that face. */
export type BotOutfitLayer = { layer: string; face?: string }

const OUTFIT_LAYERS = import.meta.glob<Record<string, BotOutfitLayer>>(
  '../../../../shared/bot-mascots/outfits/*.json',
  { import: 'default', eager: true }
)

/** The SVG drawn on `color`; the mascots read their background and rim from these defaults. */
export function recolorMascotSvg(svg: string, color: string): string {
  const filled = svg.replace(`var(--avatar-bg,${DEFAULT_BOT_AVATAR_COLOR})`, color)
  return isDarkBotAvatarColor(color) ? filled.replace('var(--avatar-rim,0)', '1') : filled
}

// Every mascot SVG ends with its face group, then the groups that place it.
const FACE_OPEN = '<g id="face">'
const FACE_TAIL = '</g></g></g></svg>'

/** The SVG wearing `outfit`, its face swapped first when the outfit has one. */
export function dressMascotSvg(svg: string, outfit: BotOutfitLayer): string {
  const trimmed = svg.trimEnd()
  const faceAt = trimmed.indexOf(FACE_OPEN)
  const faced =
    outfit.face && faceAt !== -1 && trimmed.endsWith(FACE_TAIL)
      ? `${trimmed.slice(0, faceAt + FACE_OPEN.length)}${outfit.face}${FACE_TAIL}`
      : trimmed
  return `${faced.slice(0, -'</svg>'.length)}${outfit.layer}</svg>`
}

// Bounded, since dragging the custom color makes a new one per step; an evicted look is rebuilt on its next read.
const MAX_LOOKS = 300
const looks = new Map<string, string>()

function lookSrc(id: BotMascotId, color: string | null, outfit: BotAvatarOutfit | null): string {
  const key = `${id}|${color ?? ''}|${outfit ?? ''}`
  const cached = looks.get(key)
  if (cached) {
    return cached
  }
  const svg = MASCOT_SVGS[`../../../../shared/bot-mascots/${id}.svg`]
  const layer = outfit
    ? OUTFIT_LAYERS[`../../../../shared/bot-mascots/outfits/${outfit}.json`]?.[id]
    : null
  if (!svg) {
    return BOT_MASCOT_URLS[id]
  }
  const colored = color ? recolorMascotSvg(svg, color) : svg
  const dressed = layer ? dressMascotSvg(colored, layer) : colored
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(dressed)}`
  looks.set(key, src)
  const oldest = looks.keys().next()
  if (looks.size > MAX_LOOKS && !oldest.done) {
    looks.delete(oldest.value)
  }
  return src
}

/** Each mascot's picture on `color` and wearing `outfit`; the bundled SVG on the default look. */
export function botMascotSrcs(
  ids: readonly BotMascotId[],
  color: string | null | undefined,
  outfit: BotAvatarOutfit | null | undefined = null
): Record<BotMascotId, string> {
  const tile = !color || color === DEFAULT_BOT_AVATAR_COLOR ? null : color
  const worn = outfit ?? null
  const srcs = { ...BOT_MASCOT_URLS }
  if (tile || worn) {
    for (const id of ids) {
      srcs[id] = lookSrc(id, tile, worn)
    }
  }
  return srcs
}

/** One mascot's picture on `color`, wearing `outfit`. */
export function botMascotSrc(
  id: BotMascotId | null,
  color: string | null | undefined,
  outfit: BotAvatarOutfit | null | undefined = null
): string | null {
  return id ? botMascotSrcs([id], color, outfit)[id] : null
}
