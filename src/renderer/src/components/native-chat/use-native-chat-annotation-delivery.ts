import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { getNativeChatAnnotationsStore } from './native-chat-annotations-store'
import { nativeChatAnnotationDeliveryStorage } from './native-chat-annotation-delivery'

type DeliveryState = {
  submissions: readonly AgentJournalSubmission[]
  cards: readonly { messageId: string; state: 'waiting' | 'returned' }[]
}

export function reconcileNativeChatAnnotationDeliveries(
  scopeKey: string,
  state: DeliveryState
): void {
  const store = getNativeChatAnnotationsStore(scopeKey)
  for (const delivery of nativeChatAnnotationDeliveryStorage(scopeKey).read()) {
    const card = state.cards.find((entry) => entry.messageId === delivery.messageId)
    const submission = state.submissions
      .filter(
        (entry) =>
          entry.queuedMessageId === delivery.messageId ||
          entry.clientMessageId === delivery.messageId
      )
      .sort(
        (left, right) =>
          right.submittedAt - left.submittedAt || (right.resolvedAt ?? 0) - (left.resolvedAt ?? 0)
      )
      .at(0)
    if (card?.state === 'returned') {
      store.settleDelivery(delivery.messageId, 'returned')
    } else if (card?.state === 'waiting') {
      store.settleDelivery(delivery.messageId, 'waiting')
    } else if (submission?.dispatchState === 'accepted') {
      store.settleDelivery(delivery.messageId, 'accepted')
    } else if (submission?.dispatchState === 'rejected') {
      store.settleDelivery(delivery.messageId, 'returned')
    } else if (submission) {
      store.settleDelivery(delivery.messageId, 'waiting')
    }
  }
}

export function useNativeChatAnnotationDelivery(scopeKey: string, state: DeliveryState): void {
  const { cards, submissions } = state
  const store = getNativeChatAnnotationsStore(scopeKey)
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const lastAttempt = useRef<string | undefined>(undefined)
  useEffect(() => {
    try {
      const deliveries = nativeChatAnnotationDeliveryStorage(scopeKey).read()
      if (deliveries.length === 0) {
        lastAttempt.current = undefined
        return
      }
      const stateKey = JSON.stringify([scopeKey, cards, submissions, snapshot.persistenceError])
      const attempt = JSON.stringify([stateKey, deliveries])
      if (lastAttempt.current === attempt) {
        return
      }
      lastAttempt.current = attempt
      reconcileNativeChatAnnotationDeliveries(scopeKey, { cards, submissions })
    } catch {
      const stateKey = JSON.stringify([scopeKey, cards, submissions, snapshot.persistenceError])
      if (lastAttempt.current === stateKey) {
        return
      }
      lastAttempt.current = stateKey
      // Store persistence reports unavailable storage through the annotation tray.
      store.retryPersistence()
    }
  }, [scopeKey, snapshot, cards, submissions, store])
}
