// Clearing the agent's unsubmitted input line before a chat send writes its body.
import { sendNativeChatPtyInput } from './native-chat-pty-input'
import type { RuntimeChatInputAction } from '@/runtime/runtime-chat-input-send'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../shared/agent-tui-input-clear'

// Why: agent TUI composers treat Ctrl+U as kill-to-start-of-line. Chat sends
// start from an empty line so a prior cancelled paste cannot glue onto the next
// prompt. Not used on verified option commands — model-switch confirmation
// observes the PTY and Ctrl+U can miss confirmation markers.
//
// One Ctrl+U only ever clears ONE logical line. When the line may hold an
// injected multi-line launch draft, callers pass `clearInput` built by
// buildAgentTuiClearInputForText — see agent-tui-input-clear.ts for the measured
// 2N-1 law and the sequences that do NOT work.
export const NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT = '\x15'

/** Gap before re-reading the agent's input line to confirm a clear landed. */
export const NATIVE_CHAT_CLEAR_CONFIRM_MS = 140

export type NativeChatSendOptions = {
  /** The host refused a write; nothing after it was sent. */
  onWriteRejected?: () => void
  /** A write's acknowledgment was lost; it may or may not have landed. */
  onWriteUnconfirmed?: () => void
  /** Every write was settled as accepted by the host. */
  onWritesAccepted?: () => void
  /** Bytes that empty the agent's input line. Defaults to a single Ctrl+U. */
  clearInput?: string
  /**
   * Observed check that the input line is now empty.
   * Supplied only for launch-draft replacement; when it reports "not cleared"
   * the send widens to a maximal burst before writing the body rather than
   * pasting on top of residue.
   */
  confirmCleared?: () => boolean
  /** The composer action every write of this send carries. */
  chatAction?: RuntimeChatInputAction
}

type RuntimeSettings = ReturnType<typeof getSettingsForAgentTabRuntimeOwner>

export function clearUnsubmittedAgentInput(
  settings: RuntimeSettings,
  ptyId: string,
  options?: NativeChatSendOptions
): void {
  sendNativeChatPtyInput(
    settings,
    ptyId,
    options?.clearInput ?? NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
    options?.chatAction
  )
}

/**
 * Run `writeBody` once the input line is clear. With no `confirmCleared` the
 * clear is a plain in-order write on the same byte stream, so the TUI consumes
 * it before the body and the body follows immediately. With one, we pause to
 * actually look at the agent's input line, and widen to a maximal burst when the
 * draft is still visible — the injected line count is only a lower bound on what
 * the buffer holds, since the user can type into the TUI directly.
 */
export function clearThenWrite(
  settings: RuntimeSettings,
  ptyId: string,
  options: NativeChatSendOptions | undefined,
  delay: (ms: number, fn: () => void) => void,
  writeBody: () => void
): void {
  clearUnsubmittedAgentInput(settings, ptyId, options)
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
      sendNativeChatPtyInput(settings, ptyId, AGENT_TUI_CLEAR_INPUT_MAX, options.chatAction)
    }
    writeBody()
  })
}

/** Extra time a send needs when it stops to confirm the clear before the body. */
export function clearConfirmDurationMs(options?: NativeChatSendOptions): number {
  return options?.confirmCleared ? NATIVE_CHAT_CLEAR_CONFIRM_MS : 0
}
