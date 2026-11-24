import { sendRuntimePtyInputVerified } from '@/runtime/hosted-terminals/input/runtime-terminal-verified-input'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  type NativeChatSendOptions
} from './native-chat-input-clear'
import { afterNativeChatPasteLands, readNativeChatInputLine } from './native-chat-paste-landed'

/** `afterPasteOf`: hold this write (Enter) until the input line shows that pasted message. */
export type NativeChatObservedWrite = {
  data: string
  delayBeforeMs: number
  afterPasteOf?: string
}

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
      let lineWasEmpty = false
      const whenReady = (write: NativeChatObservedWrite, send: () => void): void =>
        write.afterPasteOf !== undefined
          ? afterNativeChatPasteLands({
              readInputLine: options.readInputLine,
              lineWasEmpty,
              text: write.afterPasteOf,
              delay,
              submit: send
            })
          : send()
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
          delay(write.delayBeforeMs, () => whenReady(write, send))
        } else {
          whenReady(write, send)
        }
      }
      clearThenWrite(
        ptyId,
        options,
        delay,
        () => {
          lineWasEmpty = readNativeChatInputLine(options.readInputLine) === ''
          writeAt(0)
        },
        () => markSubmitted('not-submitted')
      )
    },
    {
      onCancelUnsubmitted: () => clearUnsubmittedAgentInput(ptyId, options),
      // A session command cancelled the queued send: nothing was submitted, as with a refused write.
      onPreempted: options.onWriteRejected
    }
  )
}
