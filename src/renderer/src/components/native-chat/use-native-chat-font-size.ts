import { useEffect, type RefObject } from 'react'
import { chatFontSizeActionForEvent } from './native-chat-font-size'
import { writeNativeChatFontSize } from './native-chat-font-size-write'
import { noteChatWheelPinch } from './native-chat-wheel-pinch'
import { isWebClientLocation } from '@/lib/web-client-location'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '../../store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

export function useNativeChatFontSize(
  enabled: boolean,
  rootRef?: RefObject<HTMLDivElement | null>
): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    const root = rootRef?.current
    if (!root) {
      return
    }
    // Trackpad pinch arrives as ctrl+wheel. Claim it on the chat under the fingers, focused or not.
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
      void writeNativeChatFontSize(event.deltaY < 0 ? 'increase' : 'decrease')
    }
    root.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => root.removeEventListener('wheel', onWheel, { capture: true })
  }, [enabled, rootRef])

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
