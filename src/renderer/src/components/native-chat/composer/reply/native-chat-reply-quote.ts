// The words a reply sends: a quote of the message it answers, written for the agent, and how the
// app reads that quote back out of sent text.

import type { NativeChatReplyTarget } from './native-chat-reply-target'

/** Quote length: enough to identify the message without resending it. */
export const NATIVE_CHAT_REPLY_EXCERPT_MAX = 500

const AGENT_HEAD = /^> Replying to the earlier message from (.+):$/
const OWN_HEAD = '> Replying to my earlier message:'

/** The message's own words: an earlier reply's quote and markdown markers are left out. */
function nativeChatReplyOwnWords(text: string): string {
  const own = nativeChatReplyQuoteOf(text)?.rest ?? text
  return own
    .split(/\r?\n/)
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) => line.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+)/, ''))
    .join('\n')
    .trim()
}

/** The message's own words up to the cap, counted in characters; a cut one ends in "…" within it. */
export function nativeChatReplyExcerpt(text: string): string {
  const trimmed = nativeChatReplyOwnWords(text)
  const characters = Array.from(trimmed)
  if (characters.length <= NATIVE_CHAT_REPLY_EXCERPT_MAX) {
    return trimmed
  }
  return `${characters
    .slice(0, NATIVE_CHAT_REPLY_EXCERPT_MAX - 1)
    .join('')
    .trimEnd()}…`
}

/** The text a reply sends: a quote of the message it answers, written for the agent, then the user's words. */
export function withNativeChatReplyContext(
  text: string,
  target: Pick<NativeChatReplyTarget, 'author' | 'excerpt' | 'agentLabel'> | null,
  agentLabel: string
): string {
  if (!target) {
    return text
  }
  const quoted = target.excerpt
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n')
  const head =
    target.author === 'agent'
      ? `> Replying to the earlier message from ${target.agentLabel ?? agentLabel}:`
      : OWN_HEAD
  const body = text.trim()
  return body ? `${head}\n${quoted}\n\n${text}` : `${head}\n${quoted}`
}

/** A sent reply's quote, read back so the user's own bubble can show it compactly. `rest` is the
 *  user's words exactly as typed. */
export function nativeChatReplyQuoteOf(
  text: string
): { author: 'agent' | 'user'; label: string | null; excerpt: string; rest: string } | null {
  // Most messages are not replies; skip the split on every row render.
  if (!text.startsWith('> Replying to ')) {
    return null
  }
  const lines = text.split(/\r?\n/)
  const agentHead = AGENT_HEAD.exec(lines[0] ?? '')
  if (!agentHead && lines[0] !== OWN_HEAD) {
    return null
  }
  let end = 1
  while (end < lines.length && lines[end].startsWith('>')) {
    end += 1
  }
  // A reply always carries a quote line (a bare ">" for an empty one); a heading alone is just text.
  if (end === 1) {
    return null
  }
  const excerpt = lines
    .slice(1, end)
    .map((line) => line.replace(/^>\s?/, ''))
    .join('\n')
    .trim()
  // The words exactly as sent, line endings included, after the one blank line the format adds.
  let offset = 0
  for (let line = 0; line < end; line += 1) {
    const next = text.indexOf('\n', offset)
    offset = next === -1 ? text.length : next + 1
  }
  return {
    author: agentHead ? 'agent' : 'user',
    label: agentHead?.[1] ?? null,
    excerpt,
    rest: text.slice(offset).replace(/^\r?\n/, '')
  }
}
