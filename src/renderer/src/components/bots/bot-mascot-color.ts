// A mascot on another tile color: its SVG with the background, and on a dark color the light rim, filled in.
import { useEffect, useSyncExternalStore } from 'react'
import { isBotMascotId, type BotMascotId } from '../../../../shared/bot-avatar'
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

// Bounded, since dragging the custom color makes a new one per step; room for the picker's 19 on several colors.
const MAX_RECOLORED = 200
const recolored = new Map<string, string>()
// How many mounted readers show each picture; those are never evicted, so a shown picture never reloads.
const shown = new Map<string, number>()
const loading = new Set<string>()
// Bumped whenever a recolored picture is ready, so readers render again.
let version = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function readVersion(): number {
  return version
}

function recoloredKey(id: BotMascotId, color: string): string {
  return `${id}${color}`
}

function loadRecolored(id: BotMascotId, color: string): void {
  const key = recoloredKey(id, color)
  const load = MASCOT_SVGS[`../../../../shared/bot-mascots/${id}.svg`]
  if (!load || recolored.has(key) || loading.has(key)) {
    return
  }
  loading.add(key)
  void load().then(
    (svg) => {
      loading.delete(key)
      recolored.set(
        key,
        `data:image/svg+xml;charset=utf-8,${encodeURIComponent(recolorMascotSvg(svg, color))}`
      )
      evictUnshown()
      version += 1
      for (const listener of listeners) {
        listener()
      }
    },
    // A picture that can't load stays on the bundled sky blue.
    () => loading.delete(key)
  )
}

function evictUnshown(): void {
  for (const stale of recolored.keys()) {
    if (recolored.size <= MAX_RECOLORED) {
      return
    }
    if (!shown.has(stale)) {
      recolored.delete(stale)
    }
  }
}

function holdShown(keys: readonly string[]): () => void {
  for (const key of keys) {
    shown.set(key, (shown.get(key) ?? 0) + 1)
  }
  return () => {
    for (const key of keys) {
      const left = (shown.get(key) ?? 1) - 1
      if (left > 0) {
        shown.set(key, left)
      } else {
        shown.delete(key)
      }
    }
  }
}

function isDefaultColor(color: string | null | undefined): color is null | undefined {
  return !color || color === DEFAULT_BOT_AVATAR_COLOR
}

// `_ready` is the cache version, passed so a memoizing compiler reads the cache again when it changes.
function mascotSrcs(
  ids: readonly BotMascotId[],
  color: string | null | undefined,
  _ready: number
): Record<BotMascotId, string> {
  const srcs = { ...BOT_MASCOT_URLS }
  if (!isDefaultColor(color)) {
    for (const id of ids) {
      srcs[id] = recolored.get(recoloredKey(id, color)) ?? BOT_MASCOT_URLS[id]
    }
  }
  return srcs
}

/** Each mascot's picture on `color`; the bundled SVG until a recolored one is ready. */
export function useBotMascotSrcs(
  ids: readonly BotMascotId[],
  color: string | null | undefined
): Record<BotMascotId, string> {
  const ready = useSyncExternalStore(subscribe, readVersion, readVersion)
  // One string, so a caller passing a fresh array each render doesn't re-run this.
  const idList = ids.join(',')
  useEffect(() => {
    if (isDefaultColor(color) || !idList) {
      return
    }
    const shownIds = idList.split(',').filter(isBotMascotId)
    const release = holdShown(shownIds.map((id) => recoloredKey(id, color)))
    for (const id of shownIds) {
      loadRecolored(id, color)
    }
    return release
  }, [idList, color])
  return mascotSrcs(ids, color, ready)
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
