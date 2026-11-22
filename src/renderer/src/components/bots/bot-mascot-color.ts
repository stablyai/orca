// A mascot on another tile color: its SVG with the background, and on a dark color the light rim, filled in.
// The SVG text ships with the page, so a new color is built in the same render: no frame shows another color.
import type { BotMascotId } from '../../../../shared/bot-avatar'
import {
  DEFAULT_BOT_AVATAR_COLOR,
  isDarkBotAvatarColor
} from '../../../../shared/bots/bot-avatar-color'
import { BOT_MASCOT_URLS } from './bot-mascots'

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

// Bounded, since dragging the custom color makes a new one per step; an evicted picture is rebuilt on its next read.
const MAX_RECOLORED = 200
const recolored = new Map<string, string>()

function recoloredSrc(id: BotMascotId, color: string): string {
  const key = `${id}${color}`
  const cached = recolored.get(key)
  if (cached) {
    return cached
  }
  const svg = MASCOT_SVGS[`../../../../shared/bot-mascots/${id}.svg`]
  if (!svg) {
    return BOT_MASCOT_URLS[id]
  }
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(recolorMascotSvg(svg, color))}`
  recolored.set(key, src)
  const oldest = recolored.keys().next()
  if (recolored.size > MAX_RECOLORED && !oldest.done) {
    recolored.delete(oldest.value)
  }
  return src
}

/** Each mascot's picture on `color`; the bundled SVG on the default color. */
function botMascotSrcs(
  ids: readonly BotMascotId[],
  color: string | null | undefined
): Record<BotMascotId, string> {
  const srcs = { ...BOT_MASCOT_URLS }
  if (color && color !== DEFAULT_BOT_AVATAR_COLOR) {
    for (const id of ids) {
      srcs[id] = recoloredSrc(id, color)
    }
  }
  return srcs
}

/** One mascot's picture on `color`. */
export function botMascotSrc(
  id: BotMascotId | null,
  color: string | null | undefined
): string | null {
  return id ? botMascotSrcs([id], color)[id] : null
}
