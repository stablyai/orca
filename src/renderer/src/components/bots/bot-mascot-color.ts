// A mascot on another tile color: its SVG with the background, and on a dark color the light rim, filled in.
import { useEffect, useState } from 'react'
import type { BotMascotId } from '../../../../shared/bot-avatar'
import {
  DEFAULT_BOT_AVATAR_COLOR,
  isDarkBotAvatarColor
} from '../../../../shared/bots/bot-avatar-color'
import { BOT_MASCOT_URLS } from './bot-mascots'

const MASCOT_SVGS = import.meta.glob<string>('../../../../shared/bot-mascots/*.svg', {
  query: '?raw',
  import: 'default'
})

/** The SVG drawn on `color`; the mascots read their background and rim from these defaults. */
export function recolorMascotSvg(svg: string, color: string): string {
  const filled = svg.replace(`var(--avatar-bg,${DEFAULT_BOT_AVATAR_COLOR})`, color)
  return isDarkBotAvatarColor(color) ? filled.replace('var(--avatar-rim,0)', '1') : filled
}

// Bounded, since dragging the custom color makes a new one per step.
const MAX_RECOLORED = 64
const recolored = new Map<string, string>()

function recoloredKey(id: BotMascotId, color: string): string {
  return `${id}${color}`
}

async function loadRecolored(id: BotMascotId, color: string): Promise<void> {
  const load = MASCOT_SVGS[`../../../../shared/bot-mascots/${id}.svg`]
  if (!load) {
    return
  }
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(recolorMascotSvg(await load(), color))}`
  recolored.set(recoloredKey(id, color), src)
  if (recolored.size > MAX_RECOLORED) {
    recolored.delete(recolored.keys().next().value as string)
  }
}

function isDefaultColor(color: string | null | undefined): color is null | undefined {
  return !color || color === DEFAULT_BOT_AVATAR_COLOR
}

/** Each mascot's picture on `color`; the bundled SVG until a recolored one is ready. */
export function useBotMascotSrcs(
  ids: readonly BotMascotId[],
  color: string | null | undefined
): Record<BotMascotId, string> {
  const [, setReady] = useState(0)
  const missing = isDefaultColor(color)
    ? []
    : ids.filter((id) => !recolored.has(recoloredKey(id, color)))
  const missingKey = missing.join(',')
  useEffect(() => {
    if (!missingKey || isDefaultColor(color)) {
      return
    }
    let live = true
    void Promise.all(
      missingKey.split(',').map((id) => loadRecolored(id as BotMascotId, color))
    ).then(() => {
      if (live) {
        setReady((n) => n + 1)
      }
    })
    return () => {
      live = false
    }
  }, [missingKey, color])
  const srcs = { ...BOT_MASCOT_URLS }
  if (!isDefaultColor(color)) {
    for (const id of ids) {
      srcs[id] = recolored.get(recoloredKey(id, color)) ?? BOT_MASCOT_URLS[id]
    }
  }
  return srcs
}

const NO_IDS: readonly BotMascotId[] = []

/** One mascot's picture on `color`. */
export function useBotMascotSrc(
  id: BotMascotId | null,
  color: string | null | undefined
): string | null {
  const srcs = useBotMascotSrcs(id ? [id] : NO_IDS, color)
  return id ? srcs[id] : null
}
