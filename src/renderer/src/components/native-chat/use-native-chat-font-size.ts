import { useEffect, type RefObject } from 'react'
import { chatFontSizeActionForEvent } from './native-chat-font-size'
import { writeNativeChatFontSize } from './native-chat-font-size-write'
import { noteChatWheelPinch } from './native-chat-wheel-pinch'
import { isWebClientLocation } from '@/lib/web-client-location'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '../../store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

// Trackpad pinch emits many small deltas; one font-size step needs this much travel.
const PINCH_STEP_DELTA = 12
const PINCH_IDLE_RESET_MS = 250

export function useNativeChatFontSize(
  focused: boolean,
  rootRef?: RefObject<HTMLDivElement | null>,
  active: boolean = true
): void {
  const enabled = focused && active
  useEffect(() => {
    if (!active) {
      return
    }
    const root = rootRef?.current
    if (!root) {
      return
    }
    // Trackpad pinch arrives as ctrl+wheel. Claim it on the chat under the fingers, focused or not.
    let accumulated = 0
    let lastWheelAt = 0
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.deltaY === 0) {
        return
      }
      if (!(event.target instanceof Node) || !root.contains(event.target)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      noteChatWheelPinch()
      if (
        event.timeStamp - lastWheelAt > PINCH_IDLE_RESET_MS ||
        Math.sign(accumulated) !== Math.sign(event.deltaY)
      ) {
        accumulated = 0
      }
      lastWheelAt = event.timeStamp
      accumulated += event.deltaY
      if (Math.abs(accumulated) < PINCH_STEP_DELTA) {
        return
      }
      const action = accumulated < 0 ? 'increase' : 'decrease'
      accumulated = 0
      void writeNativeChatFontSize(action)
    }
    root.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => root.removeEventListener('wheel', onWheel, { capture: true })
  }, [active, rootRef])

  useEffect(() => {
    if (!enabled || !isWebClientLocation()) {
      return
    }
    const platform = getShortcutPlatform()
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) {
        return
      }
      if (
        rootRef?.current &&
        (!(e.target instanceof Node) || !rootRef.current.contains(e.target))
      ) {
        return
      }
      const action = chatFontSizeActionForEvent(e, platform, useAppStore.getState().keybindings)
      if (!action) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      void writeNativeChatFontSize(action)
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [enabled, rootRef])
}
