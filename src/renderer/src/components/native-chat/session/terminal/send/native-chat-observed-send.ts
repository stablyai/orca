import { sendRuntimePtyInputVerified } from '@/runtime/hosted-terminals/input/runtime-terminal-verified-input'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  type NativeChatSendOptions
} from './native-chat-input-clear'
import {
  nativeChatInputShowsPastedText,
  NATIVE_CHAT_PASTE_LANDED_MAX_WAIT_MS,
  NATIVE_CHAT_PASTE_LANDED_POLL_MS
} from './native-chat-paste-landed'

/** `afterShown`: hold this write until the input line shows that pasted text, if it was empty before. */
export type NativeChatObservedWrite = { data: string; delayBeforeMs: number; afterShown?: string }

export function sendNativeChatObservedWrites(
  ptyId: string,
  writes: readonly NativeChatObservedWrite[],
  options: NativeChatSendOptions & { stopOnUnconfirmed?: boolean; settleDelayMs?: number }
) {
  // Dismiss answer cards only after provider acknowledgment.
  const writeOptions = options.onDeliverySettled
    ? ({ requireWriteSettlement: true } as const)
    : undefined
  return enqueueNativeChatPtySend(
    ptyId,
    writes.reduce((total, write) => total + write.delayBeforeMs, 0) +
      clearConfirmDurationMs(options) +
      (options.settleDelayMs ?? 0),
    ({ isCancelled, delay, markSubmitted, markWriteStarted }) => {
      let reportedUnconfirmed = false
      let acknowledged = true
      // Only an empty line proves a later match is this paste rather than text already there.
      let lineWasEmpty = false
      const readLine = (): string | null => {
        try {
          return options.readInputLine?.() ?? null
        } catch {
          return null
        }
      }
      const whenShown = (text: string | undefined, send: () => void): void => {
        if (text === undefined || !lineWasEmpty) {
          send()
          return
        }
        let waitedMs = 0
        const check = (): void => {
          if (
            waitedMs >= NATIVE_CHAT_PASTE_LANDED_MAX_WAIT_MS ||
            nativeChatInputShowsPastedText(readLine(), text)
          ) {
            send()
            return
          }
          waitedMs += NATIVE_CHAT_PASTE_LANDED_POLL_MS
          delay(NATIVE_CHAT_PASTE_LANDED_POLL_MS, check)
        }
        check()
      }
      const writeAt = (index: number): void => {
        if (isCancelled()) {
          return
        }
        const write = writes[index]
        if (!write) {
          const finish = (): void => {
            options.onDeliverySettled?.(acknowledged)
            markSubmitted(acknowledged ? 'submitted' : 'uncertain')
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
          delay(write.delayBeforeMs, () => whenShown(write.afterShown, send))
        } else {
          whenShown(write.afterShown, send)
        }
      }
      clearThenWrite(
        ptyId,
        options,
        delay,
        () => {
          lineWasEmpty = readLine() === ''
          writeAt(0)
        },
        () => markSubmitted('not-submitted')
      )
    },
    { onCancelUnsubmitted: () => clearUnsubmittedAgentInput(ptyId, options) }
  )
}
