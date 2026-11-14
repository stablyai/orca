import { sendRuntimePtyInput } from '@/runtime/hosted-terminals/input/runtime-terminal-input-send'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../../../../shared/agent-launch/startup/agent-tui-input-clear'

/** Gap before re-reading the agent's input line to confirm a clear landed. */
export const NATIVE_CHAT_CLEAR_CONFIRM_MS = 140

export type NativeChatSendOptions = {
  /** The host refused a write; nothing after it was sent. */
  onWriteRejected?: () => void
  /** A write's acknowledgment was lost; it may or may not have landed. */
  onWriteUnconfirmed?: () => void
  /** Request provider acknowledgments for body/submit writes; false includes uncertain acceptance. */
  onDeliverySettled?: (acknowledged: boolean) => void
  /** Bytes that empty the agent's input line. Null refuses an oversized draft; defaults to the bounded maximum clear. */
  clearInput?: string | null
  /** For launch-draft replacement, confirm empty input and widen to maximal clearing if residue remains. */
  confirmCleared?: () => boolean
  /** Reads the agent composer's current text; null when the terminal cannot be read. */
  readInputLine?: () => string | null
  /** The text just written, so a leftover in the composer can be told apart from new typing. */
  submittedText?: string
}

export function clearUnsubmittedAgentInput(ptyId: string, options?: NativeChatSendOptions): void {
  if (options?.clearInput === '' || options?.clearInput === null) {
    return
  }
  sendRuntimePtyInput(ptyId, options?.clearInput ?? AGENT_TUI_CLEAR_INPUT_MAX, 'driving')
}

/** Clear before body on the same byte stream; optional inspection waits and widens the clear because direct TUI edits can exceed the seeded draft. */
export function clearThenWrite(
  ptyId: string,
  options: NativeChatSendOptions | undefined,
  delay: (ms: number, fn: () => void) => void,
  writeBody: () => void,
  rejectClear: () => void
): void {
  if (options?.clearInput === null) {
    options.onWriteRejected?.()
    options.onDeliverySettled?.(false)
    rejectClear()
    return
  }
  clearUnsubmittedAgentInput(ptyId, options)
  const confirmCleared = options?.confirmCleared
  if (!confirmCleared) {
    writeBody()
    return
  }
  delay(NATIVE_CHAT_CLEAR_CONFIRM_MS, () => {
    let cleared = false
    try {
      cleared = confirmCleared()
    } catch {
      // An unreadable terminal is unconfirmed; the maximal clear remains safe.
    }
    if (!cleared) {
      sendRuntimePtyInput(ptyId, AGENT_TUI_CLEAR_INPUT_MAX, 'driving')
    }
    writeBody()
  })
}

/** Extra time a send needs when it stops to confirm the clear before the body. */
export function clearConfirmDurationMs(options?: NativeChatSendOptions): number {
  return options?.confirmCleared ? NATIVE_CHAT_CLEAR_CONFIRM_MS : 0
}
