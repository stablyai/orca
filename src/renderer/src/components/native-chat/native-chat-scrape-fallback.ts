// Approximate unstructured scrollback as turns; scrape priority yields to transcript/hook copies.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'

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

// Without per-agent parsing, leading shell/prompt markers are only a best-effort user-role heuristic.
const USER_PROMPT_MARKERS = ['$', '%', '>', '#', '❯', '➜', '»']

function looksLikeUserPrompt(segment: string): boolean {
  const firstLine = segment.split('\n', 1)[0]?.trimStart() ?? ''
  if (firstLine.length === 0) {
    return false
  }
  const firstChar = firstLine[0]
  return USER_PROMPT_MARKERS.includes(firstChar)
}

/** Split blank-line-separated scrollback into approximate turns; use index ids and null timestamps without a reliable clock. */
export function scrapeScrollbackToMessages(rawScrollback: string): NativeChatMessage[] {
  const cleaned = stripScrollbackAnsi(rawScrollback)
  if (cleaned.trim().length === 0) {
    return []
  }

  const segments = cleaned
    .split(/\n[ \t]*\n+/)
    .map((segment) => segment.replace(/\s+$/g, '').replace(/^\n+/, ''))
    .filter((segment) => segment.trim().length > 0)

  return segments.map((segment, index) => ({
    id: `scrape-${index}`,
    role: looksLikeUserPrompt(segment) ? 'user' : 'assistant',
    blocks: [{ type: 'text', text: segment }],
    timestamp: null,
    source: 'scrape'
  }))
}
