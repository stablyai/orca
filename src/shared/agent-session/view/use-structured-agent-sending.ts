import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { structuredAgentSessionSendingItemIds } from './structured-agent-session-sending'
import type {
  StructuredAgentSubmission,
  SubmissionReceipts
} from './structured-agent-session-submissions'

export type SubmissionReceiptSource = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => SubmissionReceipts
}

const NO_RECEIPTS: SubmissionReceipts = new Map()
const noSubscription = () => () => {}

export function createStructuredAgentSendingSource(
  receipts: SubmissionReceiptSource,
  pending: readonly { clientMessageId: string; phase?: string }[],
  submissions: readonly StructuredAgentSubmission[]
) {
  const candidates = structuredAgentSessionSendingItemIds(pending, submissions, NO_RECEIPTS)
  let previousReceipts: SubmissionReceipts = NO_RECEIPTS
  let sending = candidates
  return {
    subscribe: receipts.subscribe,
    candidates,
    getSnapshot() {
      const next = receipts.getSnapshot()
      if (next !== previousReceipts) {
        sending = structuredAgentSessionSendingItemIds(pending, submissions, next)
        previousReceipts = next
      }
      return sending
    }
  }
}

export type StructuredAgentSendingSource = ReturnType<typeof createStructuredAgentSendingSource>

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
  children: ReactNode
}): ReactNode {
  return createElement(
    StructuredAgentSendingContext,
    { value: source },
    createElement(StructuredAgentDisplayedMessagesContext, { value: isDisplayed }, children)
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
  return useSyncExternalStore(source?.subscribe ?? noSubscription, () => {
    if (source) {
      for (const id of source.getSnapshot()) {
        if (isDisplayed(id)) {
          return true
        }
      }
    }
    return false
  })
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
