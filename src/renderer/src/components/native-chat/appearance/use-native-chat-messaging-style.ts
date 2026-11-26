import { useAppStore } from '../../../store/index'

export function useNativeChatMessagingStyle(): boolean {
  return useAppStore((state) => state.settings?.nativeChatAppearance?.messageStyle === 'messaging')
}
