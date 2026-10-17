import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { reportWorkerTerminalUserInput } from '@/lib/worker-terminal-takeover-report'
import { sendNativeChatMessage, type NativeChatSendHandle } from './native-chat-runtime-send'
import type { NativeChatAsyncQuestionReply } from '../../../../shared/native-chat-async-questions'
import type { useNativeChatPendingDelivery } from './use-native-chat-pending-delivery'

type PendingReply = { handle: NativeChatSendHandle | null; finish: (accepted: boolean) => void }

/** Tracks terminal reply delivery and cancels pending writes when the session loses input ownership. */
export function useNativeChatTerminalAsyncReply(args: {
  pendingQuestions?: NativeChatAsyncQuestionReply['pendingQuestions']
  paneKey: string
  sessionId: string | null
  targetPtyId: string | null
  runtimeEnvironmentId: string | null
  /** Blocks new replies; hiding the view must not interrupt a reply already being sent. */
  disabled: boolean
  /** Cancels pending writes when a blocking prompt or another input owner takes over. */
  cancelInFlight: boolean
  delivery: ReturnType<typeof useNativeChatPendingDelivery>
  onSubmitted: () => void
}) {
  const { paneKey, sessionId, targetPtyId, runtimeEnvironmentId, disabled } = args
  const latest = useRef(args)
  const mounted = useRef(false)
  const pending = useRef<PendingReply | null>(null)
  const [sending, setSending] = useState(false)
  const cancel = useCallback(() => {
    const current = pending.current
    if (!current) {
      return
    }
    // A new blocking prompt may now own the input: cancel delayed writes without clearing it.
    current.handle?.cancel(true)
    current.finish(false)
  }, [])
  useLayoutEffect(() => {
    latest.current = args
  })
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancel()
    }
  }, [cancel, paneKey, sessionId, targetPtyId, runtimeEnvironmentId])
  useLayoutEffect(() => {
    if (args.cancelInFlight) {
      cancel()
    }
  }, [args.cancelInFlight, cancel])
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const current = latest.current
      if (
        !mounted.current ||
        current.disabled ||
        pending.current ||
        !targetPtyId ||
        !sessionId ||
        current.targetPtyId !== targetPtyId ||
        current.sessionId !== sessionId ||
        current.paneKey !== paneKey ||
        current.runtimeEnvironmentId !== runtimeEnvironmentId
      ) {
        return false
      }
      const id = current.delivery.record(text)
      setSending(true)
      return new Promise<boolean>((resolve) => {
        let outcomeRecorded = false
        const entry: PendingReply = {
          handle: null,
          finish: (accepted) => {
            if (pending.current !== entry) {
              return
            }
            pending.current = null
            setSending(false)
            if (accepted) {
              reportWorkerTerminalUserInput(paneKey, runtimeEnvironmentId)
              current.onSubmitted()
            } else if (!outcomeRecorded) {
              current.delivery.holdUnconfirmed(id)
            }
            resolve(accepted)
          }
        }
        pending.current = entry
        try {
          entry.handle = sendNativeChatMessage(targetPtyId, text, {
            onWriteRejected: () => {
              outcomeRecorded = true
              current.delivery.reject(id)
            },
            onWriteUnconfirmed: () => {
              outcomeRecorded = true
              current.delivery.holdUnconfirmed(id)
            },
            onDeliverySettled: entry.finish
          })
        } catch {
          current.delivery.holdUnconfirmed(id)
          outcomeRecorded = true
          entry.finish(false)
        }
      })
    },
    [paneKey, sessionId, targetPtyId, runtimeEnvironmentId]
  )
  const { pendingQuestions } = args
  const reply = useMemo<NativeChatAsyncQuestionReply>(
    () => ({ disabled: disabled || sending, send, pendingQuestions }),
    [disabled, sending, send, pendingQuestions]
  )
  return { reply, cancel }
}
