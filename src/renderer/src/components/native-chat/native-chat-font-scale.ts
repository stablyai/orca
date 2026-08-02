/** Pure font-scale logic for the desktop native chat view — the keyboard analog
 *  of the mobile pinch-zoom. The chat text scale is clamped to a readable band
 *  and adjusted in fixed steps so Cmd/Ctrl +/-/0 behave like a browser zoom but
 *  scoped to the chat surface only. Kept DOM-free so it can be unit-tested. */

import { isMacPlatform } from './native-chat-shortcut'

export const MIN_CHAT_FONT_SCALE = 0.8
export const MAX_CHAT_FONT_SCALE = 1.6
export const DEFAULT_CHAT_FONT_SCALE = 1
export const CHAT_FONT_SCALE_STEP = 0.1

/** Clamp a scale into the readable band and round away float drift so repeated
 *  steps land on clean tenths (e.g. 0.7999999 -> 0.8). */
export function clampChatFontScale(scale: number): number {
  const clamped = Math.min(MAX_CHAT_FONT_SCALE, Math.max(MIN_CHAT_FONT_SCALE, scale))
  return Math.round(clamped * 100) / 100
}

export function increaseChatFontScale(scale: number): number {
  return clampChatFontScale(scale + CHAT_FONT_SCALE_STEP)
}

export function decreaseChatFontScale(scale: number): number {
  return clampChatFontScale(scale - CHAT_FONT_SCALE_STEP)
}

export type ChatFontScaleAction = 'increase' | 'decrease' | 'reset' | null

/** Map a keydown to a font-scale action when it's the Cmd/Ctrl +/-/0 chord.
 *  Primary modifier follows AGENTS.md (metaKey on Mac, ctrlKey elsewhere) and
 *  must be the only primary modifier so it can't collide with Cmd+Ctrl chords.
 *  Shift/Alt are ignored on purpose: `+` is Shift+`=` on many layouts. Pure so
 *  it can be unit-tested without a DOM. */
export function chatFontScaleActionForEvent(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>,
  isMac: boolean
): ChatFontScaleAction {
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary) {
    return null
  }
  switch (e.key) {
    case '=':
    case '+':
      return 'increase'
    case '-':
    case '_':
      return 'decrease'
    case '0':
      return 'reset'
    default:
      return null
  }
}

/** Human-readable labels for the chat font-scale shortcuts, platform-correct. */
export function chatFontScaleShortcutLabels(isMac = isMacPlatform()): {
  increase: string
  decrease: string
  reset: string
} {
  const mod = isMac ? '⌘' : 'Ctrl+'
  return {
    increase: `${mod}+`,
    decrease: `${mod}-`,
    reset: `${mod}0`
  }
}
