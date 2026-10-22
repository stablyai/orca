import { useContext, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { NativeChatFileSessionContext } from './native-chat-file-session-context'
import { useAppStore } from '../../store'
import { createNativeChatFileLinkContextSelector } from './native-chat-file-link'

export function useNativeChatFileLinkContext(terminalTabId: string) {
  const selectContext = useMemo(
    () => createNativeChatFileLinkContextSelector(terminalTabId),
    [terminalTabId]
  )
  const context = useAppStore(useShallow(selectContext))
  const nativeChatContext = useContext(NativeChatFileSessionContext)
  return useMemo(
    () => (context ? { ...context, ...(nativeChatContext ? { nativeChatContext } : {}) } : null),
    [context, nativeChatContext]
  )
}
