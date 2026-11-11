import { createContext, useMemo, type ReactNode } from 'react'
import type { NativeChatFileLinkContext } from '../../links/actions/native-chat-file-link-context'
import {
  useNativeChatImageRuntimeContext,
  type NativeChatImageRuntimeContext
} from './native-chat-image-runtime-context'
import { useNativeChatFileLinkContext } from '../../links/actions/use-native-chat-file-link-context'
import { NativeChatLinkPeekProvider } from '../../links/previews/native-chat-link-peek-context'

export const NativeChatMarkdownImageOwnerContext = createContext<{
  fileLinkContext: NativeChatFileLinkContext | null
  runtimeContext: NativeChatImageRuntimeContext
  isVisible: boolean
  sessionId?: string | null
} | null>(null)

export function NativeChatMarkdownImageOwnerProvider({
  tabId,
  isVisible,
  sessionId,
  children
}: {
  tabId: string
  isVisible: boolean
  sessionId: string | null
  children: ReactNode
}): React.JSX.Element {
  const fileLinkContext = useNativeChatFileLinkContext(tabId)
  const runtimeContext = useNativeChatImageRuntimeContext(tabId)
  const value = useMemo(
    () => ({ fileLinkContext, runtimeContext, isVisible, sessionId }),
    [fileLinkContext, runtimeContext, isVisible, sessionId]
  )
  return (
    <NativeChatMarkdownImageOwnerContext.Provider value={value}>
      <NativeChatLinkPeekProvider fileLinkContext={fileLinkContext}>
        {children}
      </NativeChatLinkPeekProvider>
    </NativeChatMarkdownImageOwnerContext.Provider>
  )
}
