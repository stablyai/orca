import { sendNativeChatPtyInputVerified } from './native-chat-pty-input'
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
  options: NativeChatSendOptions
) {
  return enqueueNativeChatPtySend(
    ptyId,
    writes.reduce((total, write) => total + write.delayBeforeMs, 0) +
      clearConfirmDurationMs(options),
    ({ isCancelled, delay, markSubmitted }) => {
      let reportedUnconfirmed = false
      const writeAt = (index: number): void => {
        if (isCancelled()) {
          return
        }
        const write = writes[index]
        if (!write) {
          if (!reportedUnconfirmed) {
            options.onWritesAccepted?.()
          }
          markSubmitted()
          return
        }
        const send = (): void => {
          if (isCancelled()) {
            return
          }
          void sendNativeChatPtyInputVerified(settings, ptyId, write.data, options.chatAction)
            .then((accepted) => {
              if (isCancelled()) {
                return
              }
              if (!accepted) {
                options.onWriteRejected?.()
                markSubmitted()
                return
              }
              writeAt(index + 1)
            })
            // A lost acknowledgment is not a refusal: never re-send these bytes, but still submit
            // a body that may have landed, as the unobserved path does.
            .catch(() => {
              if (!reportedUnconfirmed) {
                reportedUnconfirmed = true
                options.onWriteUnconfirmed?.()
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
