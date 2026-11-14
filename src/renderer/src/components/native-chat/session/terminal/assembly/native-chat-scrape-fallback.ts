// Approximate unstructured scrollback as turns; scrape priority yields to transcript/hook copies.

import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'

import { stripScrollbackAnsi } from '../../../../../../../shared/terminal/output/terminal-safe-text'

export { stripScrollbackAnsi } from '../../../../../../../shared/terminal/output/terminal-safe-text'

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
