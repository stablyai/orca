import { useMemo } from 'react'
import { useAppStore } from '../../../store/index'
import { useNativeChatBackgroundUrl } from './use-native-chat-background-url'
import type { NativeChatAppearanceStyle } from './native-chat-appearance-style'

/** The chat root's picture and glass: its style plus the attributes the appearance CSS keys on. */
export function useNativeChatBackdrop(appearance: NativeChatAppearanceStyle) {
  const backgroundFileName = useAppStore(
    (state) => state.settings?.nativeChatAppearance?.backgroundImage ?? ''
  )
  const glassMessages = useAppStore(
    (state) => state.settings?.nativeChatAppearance?.glassMessages === true
  )
  const backgroundUrl = useNativeChatBackgroundUrl(backgroundFileName)
  const style = useMemo(
    () =>
      backgroundUrl
        ? { ...appearance, '--chat-background-image': `url(${JSON.stringify(backgroundUrl)})` }
        : appearance,
    [appearance, backgroundUrl]
  )
  return {
    style,
    'data-native-chat-background': backgroundUrl ? '' : undefined,
    'data-native-chat-glass': glassMessages ? '' : undefined
  }
}
