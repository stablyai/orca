import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { AgentPromptSubmissionOccurrence } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  pendingSendsAsMessages,
  readPendingSendCache,
  writePendingSendCache,
  type NativeChatPendingSend,
  type NativeChatPendingSendScope
} from './native-chat-pending'
import {
  armNativeChatDeliveryCheck,
  assignMatchingPromptSubmissions
} from './native-chat-prompt-delivery'

type DeliveryRecoveryArgs = {
  scope: NativeChatPendingSendScope
  pending: NativeChatPendingSend[]
  setPending: Dispatch<SetStateAction<NativeChatPendingSend[]>>
  messages: NativeChatMessage[]
  promptSubmissions: readonly AgentPromptSubmissionOccurrence[]
  restoreMessage: (text: string, imagePaths?: string[]) => void
}

function scheduleDeliveryChecks(
  pending: readonly NativeChatPendingSend[],
  onDeadline: (entry: NativeChatPendingSend) => void
): () => void {
  const timers = pending.flatMap((entry) => {
    const deadline = entry.deliveryCheck?.deadline
    return deadline === undefined
      ? []
      : [setTimeout(() => onDeadline(entry), Math.max(0, deadline - Date.now()))]
  })
  return () => {
    for (const timer of timers) {
      clearTimeout(timer)
    }
  }
}

export function useNativeChatDeliveryRecovery({
  scope,
  pending,
  setPending,
  messages,
  promptSubmissions,
  restoreMessage
}: DeliveryRecoveryArgs): {
  failed: boolean
  clearFailure: () => void
  markSubmitted: (pendingId: string) => void
} {
  const [failedScope, setFailedScope] = useState<NativeChatPendingSendScope | null>(null)
  const messagesRef = useRef(messages)
  const submissionsRef = useRef(promptSubmissions)
  const restoreMessageRef = useRef(restoreMessage)

  useLayoutEffect(() => {
    messagesRef.current = messages
    submissionsRef.current = promptSubmissions
    restoreMessageRef.current = restoreMessage
  }, [messages, promptSubmissions, restoreMessage])

  const updatePending = useCallback(
    (updater: (entries: NativeChatPendingSend[]) => NativeChatPendingSend[]) => {
      setPending((current) => writePendingSendCache(scope, updater(current)))
    },
    [scope, setPending]
  )

  const markSubmitted = useCallback(
    (pendingId: string) => {
      const submittedAt = Date.now()
      updatePending((entries) =>
        entries.map((entry) =>
          entry.id === pendingId && entry.deliveryCheck
            ? {
                ...entry,
                deliveryCheck: armNativeChatDeliveryCheck(
                  {
                    ...entry.deliveryCheck,
                    ...(submissionsRef.current.at(-1)
                      ? { baseline: submissionsRef.current.at(-1) }
                      : {})
                  },
                  submittedAt
                )
              }
            : entry
        )
      )
    },
    [updatePending]
  )
  const clearFailure = useCallback(() => setFailedScope(null), [])
  const failed = failedScope?.paneKey === scope.paneKey && failedScope.agent === scope.agent

  useEffect(() => {
    const assignments = assignMatchingPromptSubmissions(pending, promptSubmissions)
    const transcriptConfirmedIds = new Set(
      pending
        .filter(
          (entry) =>
            entry.deliveryCheck?.deadline !== undefined &&
            pendingSendsAsMessages([entry], messages).length === 0
        )
        .map((entry) => entry.id)
    )
    const newlyAcknowledged = pending.some(
      (entry) => !entry.deliveryCheck?.acknowledgedBy && assignments.has(entry.id)
    )
    if (transcriptConfirmedIds.size === 0 && !newlyAcknowledged) {
      return
    }
    updatePending((entries) =>
      entries.map((entry) => {
        if (transcriptConfirmedIds.has(entry.id)) {
          const { deliveryCheck: _deliveryCheck, ...confirmed } = entry
          return confirmed
        }
        const acknowledgedBy = assignments.get(entry.id)
        if (!acknowledgedBy || entry.deliveryCheck?.acknowledgedBy) {
          return entry
        }
        return {
          ...entry,
          deliveryCheck: { ...entry.deliveryCheck, deadline: undefined, acknowledgedBy }
        }
      })
    )
  }, [messages, pending, promptSubmissions, updatePending])

  const handleDeliveryDeadline = useCallback(
    (entry: NativeChatPendingSend) => {
      const cached = readPendingSendCache(scope).find((candidate) => candidate.id === entry.id)
      if (!cached?.deliveryCheck) {
        return
      }
      const cachedEntries = readPendingSendCache(scope)
      const acknowledgedBy = assignMatchingPromptSubmissions(
        cachedEntries,
        submissionsRef.current
      ).get(entry.id)
      if (acknowledgedBy) {
        setPending(
          writePendingSendCache(
            scope,
            cachedEntries.map((candidate) =>
              candidate.id === entry.id && candidate.deliveryCheck
                ? {
                    ...candidate,
                    deliveryCheck: {
                      ...candidate.deliveryCheck,
                      deadline: undefined,
                      acknowledgedBy
                    }
                  }
                : candidate
            )
          )
        )
        return
      }
      if (pendingSendsAsMessages([cached], messagesRef.current).length === 0) {
        return
      }
      const next = readPendingSendCache(scope).filter((candidate) => candidate.id !== entry.id)
      setPending(writePendingSendCache(scope, next))
      restoreMessageRef.current(cached.text, cached.imagePaths)
      setFailedScope(scope)
    },
    [scope, setPending]
  )

  useEffect(() => {
    return scheduleDeliveryChecks(pending, handleDeliveryDeadline)
  }, [handleDeliveryDeadline, pending])

  return { failed, clearFailure, markSubmitted }
}
