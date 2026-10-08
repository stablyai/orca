import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  type NativeChatSendOptions
} from './native-chat-input-clear'

/** Observe write refusals without mistaking transport success for provider acceptance. */
export function sendNativeChatObservedWrites(
  settings: ReturnType<typeof getSettingsForAgentTabRuntimeOwner>,
  ptyId: string,
  writes: readonly { data: string; delayBeforeMs: number }[],
  options: NativeChatSendOptions & { stopOnUnconfirmed?: boolean; settleDelayMs?: number }
) {
  // Why: only an answer that dismisses its card needs the provider's acknowledgment.
  const writeOptions = options.onDeliverySettled
    ? ({ requireWriteSettlement: true } as const)
    : undefined
  return enqueueNativeChatPtySend(
    ptyId,
    writes.reduce((total, write) => total + write.delayBeforeMs, 0) +
      clearConfirmDurationMs(options) +
      (options.settleDelayMs ?? 0),
    ({ isCancelled, delay, markSubmitted }) => {
      let reportedUnconfirmed = false
      let acknowledged = true
      const writeAt = (index: number): void => {
        if (isCancelled()) {
          return
        }
        const write = writes[index]
        if (!write) {
          const finish = (): void => {
            options.onDeliverySettled?.(acknowledged)
            markSubmitted()
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
          void sendRuntimePtyInputVerified(settings, ptyId, write.data, 'driving', writeOptions)
            .then((accepted) => {
              if (isCancelled()) {
                return
              }
              if (!accepted) {
                options.onWriteRejected?.()
                options.onDeliverySettled?.(false)
                markSubmitted()
                return
              }
              writeAt(index + 1)
            })
            // A lost acknowledgment is not a refusal: never re-send these bytes, but still submit
            // a body that may have landed, as the unobserved path does.
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
                markSubmitted()
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
      clearThenWrite(settings, ptyId, options, delay, () => writeAt(0))
    },
    { onCancelUnsubmitted: () => clearUnsubmittedAgentInput(settings, ptyId, options) }
  )
}
