// Minimal ANSI/OSC/control-sequence strip for turning a raw terminal viewport or
// scrollback string into plain text. Extracted from
// src/renderer/src/components/native-chat/native-chat-scrape-fallback.ts (which re-exports
// it for its existing importers) so src/shared consumers — like the startup-notice reader,
// which is not renderer-only — can use it too. Same three patterns as
// agent-session-fork-context.ts's local copy: CSI sequences, OSC sequences, and stray
// single-char escapes.

const ESC = String.fromCharCode(27)
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const OSC_SEQUENCE_PATTERN = new RegExp(`${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g')
const SINGLE_ESCAPE_PATTERN = new RegExp(`${ESC}(?:[@-Z\\\\-_]|[()*+\\-./][0-~]|c)`, 'g')

function stripUnsupportedControlCharacters(value: string): string {
  let result = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    // Drop C0 control chars except tab (9) and newline (10); keep DEL (127) out.
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      continue
    }
    result += char
  }
  return result
}

/** Strip ANSI/OSC escapes and normalize newlines so raw terminal output reads as plain text. */
export function stripScrollbackAnsi(value: string): string {
  return stripUnsupportedControlCharacters(
    value
      .replace(OSC_SEQUENCE_PATTERN, '')
      .replace(ANSI_ESCAPE_PATTERN, '')
      .replace(SINGLE_ESCAPE_PATTERN, '')
  )
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}
