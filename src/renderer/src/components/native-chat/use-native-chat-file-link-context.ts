import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { resolveNativeChatFileLinkContext } from './native-chat-file-link'

export function useNativeChatFileLinkContext(terminalTabId: string) {
  return useAppStore(useShallow((state) => resolveNativeChatFileLinkContext(state, terminalTabId)))
}
