import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import {
  selectNativeChatAppearanceSettings,
  useNativeChatAppearanceStyle
} from './native-chat-appearance-style'

export function useNativeChatStoreAppearanceStyle(measuredColumnWidthPx?: number | null) {
  const settings = useAppStore(
    useShallow((state) => selectNativeChatAppearanceSettings(state.settings))
  )
  return useNativeChatAppearanceStyle(settings, measuredColumnWidthPx)
}
