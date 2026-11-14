import { sendRuntimePtyInputVerified } from '@/runtime/hosted-terminals/input/runtime-terminal-verified-input'
import {
  enqueueNativeChatPtySend,
  type NativeChatPtySubmissionOutcome
} from './native-chat-pty-send-queue'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  type NativeChatSendOptions
} from './native-chat-input-clear'
import { NATIVE_CHAT_SUBMIT } from '../../../../../../../shared/native-chat/input/native-chat-paste-bytes'
import { composerShowsCollapsedInput } from '../../../../../../../shared/native-chat/input/collapsed-composer-input'

/** Gap before re-reading the composer to confirm the agent consumed Enter. */
export const NATIVE_CHAT_SUBMIT_CONFIRM_MS = 500

/** True only when the composer still shows the text we wrote; null means unreadable. */
export function composerStillHoldsSubmittedText(line: string | null, sent: string): boolean {
  if (line === null) {
    return false
  }
  const current = line.replace(/\s+/gu, ' ').trim()
  if (!current) {
    return false
  }
  const expected = sent.replace(/\s+/gu, ' ').trim()
  if (!expected) {
    // An image-only send leaves no text to identify; a placeholder line proves nothing about Enter.
    return false
  }
  // A collapsed paste label stands for text the line cannot spell out, so it may still be ours.
  if (composerShowsCollapsedInput(current)) {
    return true
  }
  if (current.includes(expected)) {
    return true
  }
  // Long pastes wrap and the visible line truncates; the last distinctive word still identifies ours.
  const token = expected.split(' ').findLast((part) => part.length >= 8)
  return token !== undefined && current.includes(token)
}

export function sendNativeChatObservedWrites(
  ptyId: string,
  writes: readonly { data: string; delayBeforeMs: number }[],
  options: NativeChatSendOptions & { stopOnUnconfirmed?: boolean; settleDelayMs?: number }
) {
  // Dismiss answer cards only after provider acknowledgment.
  const writeOptions = options.onDeliverySettled
    ? ({ requireWriteSettlement: true } as const)
    : undefined
  const confirmsSubmit = options.readInputLine !== undefined && options.submittedText !== undefined
  return enqueueNativeChatPtySend(
    ptyId,
    writes.reduce((total, write) => total + write.delayBeforeMs, 0) +
      clearConfirmDurationMs(options) +
      (options.settleDelayMs ?? 0) +
      (confirmsSubmit ? NATIVE_CHAT_SUBMIT_CONFIRM_MS * 2 : 0),
    ({ isCancelled, delay, markSubmitted, markWriteStarted }) => {
      let reportedUnconfirmed = false
      let acknowledged = true
      const readInputLine = (): string | null => {
        try {
          return options.readInputLine?.() ?? null
        } catch {
          return null
        }
      }
      const writeAt = (index: number): void => {
        if (isCancelled()) {
          return
        }
        const write = writes[index]
        if (!write) {
          const settle = (outcome: NativeChatPtySubmissionOutcome): void => {
            options.onDeliverySettled?.(outcome === 'submitted')
            markSubmitted(outcome)
          }
          const finish = (): void => {
            // Why: the composer read is the only proof the agent consumed Enter; unreadable or unacknowledged stays best-effort.
            if (!confirmsSubmit || !acknowledged) {
              settle(acknowledged ? 'submitted' : 'uncertain')
              return
            }
            delay(NATIVE_CHAT_SUBMIT_CONFIRM_MS, () => {
              if (isCancelled()) {
                return
              }
              const submittedText = options.submittedText ?? ''
              if (!composerStillHoldsSubmittedText(readInputLine(), submittedText)) {
                settle('submitted')
                return
              }
              // Why: a busy agent can drop the separate Enter; press it once more before declaring the send lost.
              void sendRuntimePtyInputVerified(ptyId, NATIVE_CHAT_SUBMIT, 'driving')
                .then((accepted) => {
                  if (isCancelled()) {
                    return
                  }
                  if (!accepted) {
                    settle('uncertain')
                    return
                  }
                  delay(NATIVE_CHAT_SUBMIT_CONFIRM_MS, () => {
                    if (isCancelled()) {
                      return
                    }
                    settle(
                      composerStillHoldsSubmittedText(readInputLine(), submittedText)
                        ? 'not-submitted'
                        : 'submitted'
                    )
                  })
                })
                .catch(() => settle('uncertain'))
            })
          }
          if (options.settleDelayMs) {
            delay(options.settleDelayMs, finish)
          } else {
            finish()
          }
          return
        }
        const send = (): void => {
          if (isCancelled()) {
            return
          }
          markWriteStarted()
          void sendRuntimePtyInputVerified(ptyId, write.data, 'driving', writeOptions)
            .then((accepted) => {
              if (isCancelled()) {
                return
              }
              if (!accepted) {
                options.onWriteRejected?.()
                options.onDeliverySettled?.(false)
                markSubmitted(index === 0 ? 'not-submitted' : 'uncertain')
                return
              }
              writeAt(index + 1)
            })
            // Lost acknowledgments must not replay bytes; submit the possibly delivered body as on the unobserved path.
            .catch(() => {
              if (isCancelled()) {
                return
              }
              acknowledged = false
              if (!reportedUnconfirmed) {
                reportedUnconfirmed = true
                options.onWriteUnconfirmed?.()
              }
              if (options.stopOnUnconfirmed) {
                options.onDeliverySettled?.(false)
                markSubmitted('uncertain')
                return
              }
              writeAt(index + 1)
            })
        }
        if (write.delayBeforeMs > 0) {
          delay(write.delayBeforeMs, send)
        } else {
          send()
        }
      }
      clearThenWrite(ptyId, options, delay, () => writeAt(0), markSubmitted)
    },
    { onCancelUnsubmitted: () => clearUnsubmittedAgentInput(ptyId, options) }
  )
}
