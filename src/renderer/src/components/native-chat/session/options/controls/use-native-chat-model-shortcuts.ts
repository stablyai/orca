import { useEffect, useEffectEvent, type RefObject } from 'react'
import { keybindingMatchesAction } from '../../../../../../../shared/keybindings/matching'
import { useAppStore } from '@/store/index'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { MODEL_PRESET_SLOTS, type ModelPresetSlot } from './native-chat-model-presets'

export function useNativeChatModelShortcuts(args: {
  enabled: boolean
  rootRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  open: () => void
  apply: (slot: ModelPresetSlot) => void
}): void {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    const root = args.rootRef.current
    const target = event.target
    if (
      !args.enabled ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      !root ||
      !(target instanceof Element) ||
      target.closest('[data-shortcut-recorder-active]') ||
      root.closest('[hidden], [inert], [aria-hidden="true"], .hidden')
    ) {
      return
    }
    const chat = root.closest('[data-native-chat-root]')
    const composer = target.closest('[data-native-chat-composer-scope]')
    const owns =
      root.contains(target) ||
      args.contentRef.current?.contains(target) ||
      (chat &&
        target.closest('[data-native-chat-root]') === chat &&
        (!composer || composer.contains(root)))
    if (!owns) {
      return
    }
    const matches = (id: 'chat.openModelPicker' | `chat.modelPreset${ModelPresetSlot}`) =>
      keybindingMatchesAction(id, event, getShortcutPlatform(), useAppStore.getState().keybindings)
    const slot = MODEL_PRESET_SLOTS.find((slot) => matches(`chat.modelPreset${slot}`))
    if (!slot && !matches('chat.openModelPicker')) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) {
      if (slot) {
        args.apply(slot)
      } else {
        args.open()
      }
    }
  })
  useEffect(() => {
    addAppKeyListener('keydown', handle)
    return () => removeAppKeyListener('keydown', handle)
  }, [])
}
