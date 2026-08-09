import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type {
  AgentPromptSubmissionOccurrence,
  AgentType
} from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendPendingSendCache,
  nextNativeChatPendingSendId,
  prunePendingSends,
  readPendingSendCache,
  writePendingSendCache,
  type NativeChatPendingSend
} from './native-chat-pending'
import { nativeChatPromptDigest } from './native-chat-prompt-delivery'
import { useNativeChatDeliveryRecovery } from './use-native-chat-delivery-recovery'

export function useNativeChatPendingDelivery({
  paneKey,
  agent,
  messages,
  promptSubmissions,
  restoreMessage,
  setWorkingInterrupted
}: {
  paneKey: string
  agent: AgentType
  messages: NativeChatMessage[]
  promptSubmissions: readonly AgentPromptSubmissionOccurrence[]
  restoreMessage: (text: string, imagePaths?: string[]) => void
  setWorkingInterrupted: Dispatch<SetStateAction<boolean>>
}): {
  pending: NativeChatPendingSend[]
  deliveryFailed: boolean
  clearPending: () => void
  onOptimisticSend: (text: string, imagePaths?: string[]) => string
  onOptimisticSendCanceled: (pendingId: string) => void
  markDeliverySubmitted: (pendingId: string) => void
} {
  const scope = useMemo(() => ({ paneKey, agent }), [agent, paneKey])
  const [pending, setPending] = useState<NativeChatPendingSend[]>(() => readPendingSendCache(scope))
  const {
    failed: deliveryFailed,
    clearFailure,
    markSubmitted: markDeliverySubmitted
  } = useNativeChatDeliveryRecovery({
    scope,
    pending,
    setPending,
    messages,
    promptSubmissions,
    restoreMessage
  })

  useEffect(() => {
    setPending(readPendingSendCache(scope))
    setWorkingInterrupted(false)
  }, [scope, setWorkingInterrupted])

  useEffect(() => {
    setPending((current) => writePendingSendCache(scope, prunePendingSends(current, messages)))
  }, [messages, scope])

  const clearPending = useCallback(() => {
    setPending(writePendingSendCache(scope, []))
  }, [scope])

  const onOptimisticSend = useCallback(
    (text: string, imagePaths?: string[]): string => {
      clearFailure()
      setWorkingInterrupted(false)
      const sentAt = Date.now()
      const boundary = messages.at(-1)
      const entry: NativeChatPendingSend = {
        id: nextNativeChatPendingSendId(sentAt),
        text,
        sentAt,
        afterMessageId: boundary?.id ?? null,
        afterMessageTimestamp: boundary?.timestamp ?? null,
        ...(text.trim().length > 0 && !imagePaths?.length
          ? {
              deliveryCheck: {
                expectedDigest: nativeChatPromptDigest(text),
                ...(promptSubmissions.at(-1) ? { baseline: promptSubmissions.at(-1) } : {})
              }
            }
          : {}),
        ...(imagePaths ? { imagePaths } : {})
      }
      setPending(appendPendingSendCache(scope, entry))
      return entry.id
    },
    [clearFailure, messages, promptSubmissions, scope, setWorkingInterrupted]
  )

  const onOptimisticSendCanceled = useCallback(
    (pendingId: string) => {
      const next = readPendingSendCache(scope).filter((entry) => entry.id !== pendingId)
      setPending(writePendingSendCache(scope, next))
    },
    [scope]
  )

  return {
    pending,
    deliveryFailed,
    clearPending,
    onOptimisticSend,
    onOptimisticSendCanceled,
    markDeliverySubmitted
  }
}
