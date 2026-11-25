import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import {
  structuredAgentDisplayedSendPending,
  type StructuredAgentSendingSource
} from '../../../../../../../shared/agent-session/view/structured-agent-sending-source'

const noSubscription = () => () => {}

const StructuredAgentSendingContext = createContext<StructuredAgentSendingSource | undefined>(
  undefined
)
const StructuredAgentDisplayedMessagesContext = createContext<(id: string) => boolean>(() => false)

export function StructuredAgentSendingScope({
  source,
  isDisplayed,
  children
}: {
  source?: StructuredAgentSendingSource
  isDisplayed: (id: string) => boolean
  children?: ReactNode
}): ReactNode {
  return (
    <StructuredAgentSendingContext value={source}>
      <StructuredAgentDisplayedMessagesContext value={isDisplayed}>
        {children}
      </StructuredAgentDisplayedMessagesContext>
    </StructuredAgentSendingContext>
  )
}

export function useStructuredAgentItemSending(id: string | undefined): boolean {
  const source = useContext(StructuredAgentSendingContext)
  const candidate = id !== undefined && source?.candidates.has(id) ? source : undefined
  return useSyncExternalStore(
    candidate?.subscribe ?? noSubscription,
    () => id !== undefined && candidate?.getSnapshot().has(id) === true
  )
}

export function useStructuredAgentDisplayedSendPending(): boolean {
  const source = useContext(StructuredAgentSendingContext)
  const isDisplayed = useContext(StructuredAgentDisplayedMessagesContext)
  return useSyncExternalStore(source?.subscribe ?? noSubscription, () =>
    structuredAgentDisplayedSendPending(source, isDisplayed)
  )
}

export function StructuredAgentWorkingGate({
  children,
  whileSending = false
}: {
  children: ReactNode
  whileSending?: boolean
}): ReactNode {
  return useStructuredAgentDisplayedSendPending() === whileSending ? children : null
}
