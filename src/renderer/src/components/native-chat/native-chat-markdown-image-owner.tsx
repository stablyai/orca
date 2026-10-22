import { createContext, useMemo, type ReactNode } from 'react'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import {
  useNativeChatImageRuntimeContext,
  type NativeChatImageRuntimeContext
} from './native-chat-image-runtime-context'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'

export const NativeChatMarkdownImageOwnerContext = createContext<{
  fileLinkContext: NativeChatFileLinkContext | null
  runtimeContext: NativeChatImageRuntimeContext
  isVisible: boolean
} | null>(null)

export function NativeChatMarkdownImageOwnerProvider({
  tabId,
  isVisible,
  children
}: {
  tabId: string
  isVisible: boolean
  children: ReactNode
}): React.JSX.Element {
  const fileLinkContext = useNativeChatFileLinkContext(tabId)
  const runtimeContext = useNativeChatImageRuntimeContext(tabId)
  const value = useMemo(
    () => ({
      fileLinkContext,
      runtimeContext: runtimeContext
        ? { ...runtimeContext, nativeChatContext: fileLinkContext?.nativeChatContext }
        : null,
      isVisible
    }),
    [fileLinkContext, runtimeContext, isVisible]
  )
  return (
    <NativeChatMarkdownImageOwnerContext.Provider value={value}>
      {children}
    </NativeChatMarkdownImageOwnerContext.Provider>
  )
}
