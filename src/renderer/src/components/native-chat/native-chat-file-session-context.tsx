import { createContext, useMemo, type ReactNode } from 'react'
import type { RuntimeNativeChatFileContext } from '../../../../shared/runtime-file-contracts'

export const NativeChatFileSessionContext = createContext<RuntimeNativeChatFileContext | null>(null)

export function NativeChatFileSessionProvider({
  tabId,
  sessionId,
  children
}: {
  tabId: string
  sessionId: string | null
  children: ReactNode
}): React.JSX.Element {
  const value = useMemo(() => (sessionId ? { tabId, sessionId } : null), [tabId, sessionId])
  return (
    <NativeChatFileSessionContext.Provider value={value}>
      {children}
    </NativeChatFileSessionContext.Provider>
  )
}
