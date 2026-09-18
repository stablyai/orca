import { useAppStore } from '../../store'
import {
  normalizeNativeChatSendShortcut,
  type NativeChatSendShortcut
} from '../../../../shared/native-chat-send-shortcut'

/** Reads the configured send shortcut, with an optional isolated-consumer override. */
export function useNativeChatSendShortcut(
  override?: NativeChatSendShortcut
): NativeChatSendShortcut {
  const configuredShortcut = useAppStore((store) =>
    normalizeNativeChatSendShortcut(store.settings?.nativeChatSendShortcut)
  )
  return override ?? configuredShortcut
}
