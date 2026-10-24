import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import type { RuntimeNativeChatFileContext } from '../../../../shared/runtime-types'
import { useNativeChatImageRuntimeContext } from './native-chat-image-runtime-context'

export type NativeChatResourceOwner = {
  runtimeContext: RuntimeFileOperationArgs | null
  nativeChatContext: RuntimeNativeChatFileContext
}

export const NativeChatResourceOwnerContext = createContext<NativeChatResourceOwner | null>(null)

export function useNativeChatResourceOwner(): NativeChatResourceOwner | null {
  return useContext(NativeChatResourceOwnerContext)
}

/** Resource paths stay on this conversation's host while another workspace is focused. */
export function NativeChatResourceOwnerProvider({
  tabId,
  sessionId,
  children
}: {
  tabId: string
  sessionId: string | null
  children: ReactNode
}): React.JSX.Element {
  const runtimeContext = useNativeChatImageRuntimeContext(tabId)
  const owner = useMemo(
    () => (sessionId ? { runtimeContext, nativeChatContext: { tabId, sessionId } } : null),
    [runtimeContext, tabId, sessionId]
  )
  return (
    <NativeChatResourceOwnerContext.Provider value={owner}>
      {children}
    </NativeChatResourceOwnerContext.Provider>
  )
}
