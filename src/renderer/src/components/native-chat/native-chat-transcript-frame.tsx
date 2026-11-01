import { createContext, useContext, type ReactNode } from 'react'
import {
  NativeChatDisclosureContext,
  type NativeChatDisclosureStore
} from './native-chat-disclosure-store'

const NativeChatOpenSubagentContext = createContext<((agentId: string) => void) | null>(null)

export function useNativeChatOpenSubagent(): ((agentId: string) => void) | null {
  return useContext(NativeChatOpenSubagentContext)
}

export function NativeChatOpenSubagentProvider({
  onOpen,
  children
}: {
  onOpen: (agentId: string | null) => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <NativeChatOpenSubagentContext.Provider value={onOpen}>
      {children}
    </NativeChatOpenSubagentContext.Provider>
  )
}

/** Disclosure memory plus the control that opens a child from its spawn card. */
export function NativeChatTranscriptFrame({
  disclosures,
  open,
  children
}: {
  disclosures: NativeChatDisclosureStore
  open: (agentId: string | null) => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <NativeChatOpenSubagentProvider onOpen={open}>{children}</NativeChatOpenSubagentProvider>
    </NativeChatDisclosureContext.Provider>
  )
}
