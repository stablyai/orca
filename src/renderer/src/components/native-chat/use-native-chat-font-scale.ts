import { useCallback, useEffect, useState } from 'react'
import {
  chatFontScaleActionForEvent,
  decreaseChatFontScale,
  DEFAULT_CHAT_FONT_SCALE,
  increaseChatFontScale
} from './native-chat-font-scale'
import { isMacPlatform } from './native-chat-shortcut'

export type ChatFontScaleControls = {
  /** Current chat text scale (1 = default). Apply as a font-size multiplier. */
  scale: number
  increase: () => void
  decrease: () => void
  reset: () => void
}

/**
 * In-session chat font scale plus the Cmd/Ctrl +/-/0 keyboard bindings — the
 * desktop analog of mobile pinch-zoom. `enabled` gates the listener to the
 * focused/active chat view so the chord can't act when chat isn't on screen,
 * keeping the scale scoped to the chat surface rather than the whole app. The
 * scale lives in component state (in-session is fine per the plan).
 */
export function useNativeChatFontScale(enabled: boolean): ChatFontScaleControls {
  const [scale, setScale] = useState(DEFAULT_CHAT_FONT_SCALE)

  const increase = useCallback(() => setScale((s) => increaseChatFontScale(s)), [])
  const decrease = useCallback(() => setScale((s) => decreaseChatFontScale(s)), [])
  const reset = useCallback(() => setScale(DEFAULT_CHAT_FONT_SCALE), [])

  useEffect(() => {
    if (!enabled) {
      return
    }
    const isMac = isMacPlatform()
    const onKeyDown = (e: KeyboardEvent): void => {
      const action = chatFontScaleActionForEvent(e, isMac)
      if (!action) {
        return
      }
      // Why: capture-phase + preventDefault so the chord drives chat zoom instead
      // of the host (Electron) page zoom, and only while chat is active.
      e.preventDefault()
      e.stopPropagation()
      if (action === 'increase') {
        increase()
      } else if (action === 'decrease') {
        decrease()
      } else {
        reset()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled, increase, decrease, reset])

  return { scale, increase, decrease, reset }
}
