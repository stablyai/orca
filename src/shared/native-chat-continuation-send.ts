import { normalizeNativeChatUserText } from './native-chat-image-transcript-markers'

/**
 * The text a send left sitting on the agent's input line, or null when it was an
 * ordinary submit.
 *
 * A draft ending in `\` — a stray keystroke as often as a deliberate one — is
 * taken by the agent TUI as a newline rather than Enter: over a pty, `foo\` + CR
 * drops one trailing backslash, opens a new input line and submits nothing, so
 * the turn that eventually lands only STARTS with this send ("foo\nbar"). Its
 * optimistic echo can therefore never equal a transcript turn.
 */
export function nativeChatContinuationSendText(text: string): string | null {
  return text.endsWith('\\') ? normalizeNativeChatUserText(text.slice(0, -1)) : null
}
