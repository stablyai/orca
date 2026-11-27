import { isWindowsUserAgent } from '@/app-shell/platform/user-agent-platform'

// Far beyond any pasted command; keeps a block of mostly blank lines from stalling the gesture.
export const CODE_CLIPBOARD_LINE_ENDING_MAX_LENGTH = 256 * 1024

// ConPTY/conhost delivers a pasted bare LF as Ctrl+Enter, which PSReadLine binds to InsertLineAbove,
// so LF-only commands paste in reverse order. CRLF is the Windows clipboard convention.
export function toCodeClipboardText(text: string, isWindows = isWindowsUserAgent()): string {
  return isWindows && text.length <= CODE_CLIPBOARD_LINE_ENDING_MAX_LENGTH
    ? text.replace(/\r?\n/g, '\r\n')
    : text
}

// A prompt splits lines on LF only, so a pasted CRLF would leave a hidden CR in the draft.
// A lone CR is kept: terminal output uses it for progress redraws, not line breaks.
export function toLfPastedText(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n/g, '\n') : text
}
