import { sendRuntimePtyInput } from '@/runtime/hosted-terminals/input/runtime-terminal-input-send'
import { sendRuntimePtyInputVerified } from '@/runtime/hosted-terminals/input/runtime-terminal-verified-input'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../../../../shared/agent-launch/startup/agent-tui-input-clear'
import { readNativeChatInputLine } from './native-chat-paste-landed'

/** Gap after a clear so the agent reads it on its own and the input line can be re-read. */
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
  /** The user's text on the agent's input line: '' when empty, null when unreadable. */
  readInputLine?: () => string | null | undefined
}

/** Clear a cancelled send's own body; the pre-send clear is sized for the old line, not the body. */
export function clearUnsubmittedAgentInput(ptyId: string, options?: NativeChatSendOptions): void {
  if (options?.clearInput === '' || options?.clearInput === null) {
    return
  }
  sendRuntimePtyInput(ptyId, AGENT_TUI_CLEAR_INPUT_MAX, 'driving')
}

/** Clear before body. Agent TUIs take a clear that arrives with the body as pasted text and drop
 *  it, merging the old line into the message, so the body waits until the clear was read alone. */
export function clearThenWrite(
  ptyId: string,
  options: NativeChatSendOptions | undefined,
  delay: (ms: number, fn: () => void) => void,
  writeBody: () => void,
  rejectClear: () => void
): void {
  const refuse = (): void => {
    options?.onWriteRejected?.()
    options?.onDeliverySettled?.(false)
    rejectClear()
  }
  if (options?.clearInput === null) {
    refuse()
    return
  }
  // Nothing typed means nothing to clear; cancellation still clears this send's own body.
  if (options?.clearInput === '' || readNativeChatInputLine(options?.readInputLine) === '') {
    writeBody()
    return
  }
  // Time the gap from the host's acknowledgment so transport latency cannot rejoin clear and body.
  const clearAlone = (bytes: string, then: () => void): void => {
    void sendRuntimePtyInputVerified(ptyId, bytes, 'driving').then(
      // Through delay so a send cancelled meanwhile stays silent.
      (accepted) => delay(accepted ? NATIVE_CHAT_CLEAR_CONFIRM_MS : 0, accepted ? then : refuse),
      () => delay(NATIVE_CHAT_CLEAR_CONFIRM_MS, then)
    )
  }
  clearAlone(options?.clearInput ?? AGENT_TUI_CLEAR_INPUT_MAX, () => {
    const line = readNativeChatInputLine(options?.readInputLine)
    // Unreadable is unconfirmed; typed residue means direct TUI edits outgrew the sized clear.
    if (line === null || line === '') {
      writeBody()
      return
    }
    // A refusal here would drop non-Claude sends silently, and a slow redraw would refuse a clear that landed.
    clearAlone(AGENT_TUI_CLEAR_INPUT_MAX, writeBody)
  })
}

/** Time a send may spend clearing before its body; the widened retry is not reserved. */
export function clearConfirmDurationMs(options?: NativeChatSendOptions): number {
  return options?.clearInput === '' ? 0 : NATIVE_CHAT_CLEAR_CONFIRM_MS
}
