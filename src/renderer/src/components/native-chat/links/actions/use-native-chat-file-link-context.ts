import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../../store/index'
import { createNativeChatFileLinkContextSelector } from './native-chat-file-link-context'

export function useNativeChatFileLinkContext(terminalTabId: string) {
  const selectContext = useMemo(
    () => createNativeChatFileLinkContextSelector(terminalTabId),
    [terminalTabId]
  )
  return useAppStore(useShallow(selectContext))
}
