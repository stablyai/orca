import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../shared/agent-tui-input-clear'

// Ctrl+U clears only one logical line; multi-line launch drafts need buildAgentTuiClearInputForText, while verified option commands skip clearing.
export const NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT = '\x15'

/** Gap before re-reading the agent's input line to confirm a clear landed. */
export const NATIVE_CHAT_CLEAR_CONFIRM_MS = 140

export type NativeChatSendOptions = {
  /** The host refused a write; nothing after it was sent. */
  onWriteRejected?: () => void
  /** A write's acknowledgment was lost; it may or may not have landed. */
  onWriteUnconfirmed?: () => void
  /** Request provider acknowledgments for body/submit writes; false includes uncertain acceptance. */
  onDeliverySettled?: (acknowledged: boolean) => void
  /** Bytes that empty the agent's input line. Defaults to a single Ctrl+U. */
  clearInput?: string
  /** For launch-draft replacement, confirm empty input and widen to maximal clearing if residue remains. */
  confirmCleared?: () => boolean
}

export function clearUnsubmittedAgentInput(ptyId: string, options?: NativeChatSendOptions): void {
  if (options?.clearInput === '') {
    return
  }
  sendRuntimePtyInput(ptyId, options?.clearInput ?? NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT, 'driving')
}

/** Clear before body on the same byte stream; optional inspection waits and widens the clear because direct TUI edits can exceed the seeded draft. */
export function clearThenWrite(
  ptyId: string,
  options: NativeChatSendOptions | undefined,
  delay: (ms: number, fn: () => void) => void,
  writeBody: () => void
): void {
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
