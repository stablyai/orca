import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import {
  createNativeChatFileLinkContextSelector,
  type NativeChatFileLinkContext
} from './native-chat-file-link'

export function useNativeChatFileLinkContext(
  terminalTabId: string,
  chatSessionId?: string | null
): NativeChatFileLinkContext | null {
  const selectContext = useMemo(
    () => createNativeChatFileLinkContextSelector(terminalTabId),
    [terminalTabId]
  )
  const context = useAppStore(useShallow(selectContext))
  return useMemo(
    () => (context && chatSessionId ? { ...context, chatSessionId } : context),
    [context, chatSessionId]
  )
}
