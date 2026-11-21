// The words a reply sends: a quote of the message it answers, written for the agent, and how the
// app reads that quote back out of sent text.

import type { NativeChatReplyTarget } from './native-chat-reply-target'

/** Quote length: enough to identify the message without resending it. */
export const NATIVE_CHAT_REPLY_EXCERPT_MAX = 500

const AGENT_HEAD = /^> Replying to the earlier message from (.+):$/
const OWN_HEAD = '> Replying to my earlier message:'

/** The message's own words: an earlier reply's quote and markdown markers are left out. */
export function nativeChatReplyOwnWords(text: string): string {
  const own = nativeChatReplyQuoteOf(text)?.rest ?? text
  return own
    .split(/\r?\n/)
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) => line.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+)/, ''))
    .join('\n')
    .trim()
}

/** The message's own words up to the cap. */
export function nativeChatReplyExcerpt(text: string): string {
  const trimmed = nativeChatReplyOwnWords(text)
  if (trimmed.length <= NATIVE_CHAT_REPLY_EXCERPT_MAX) {
    return trimmed
  }
  return `${trimmed.slice(0, NATIVE_CHAT_REPLY_EXCERPT_MAX).trimEnd()}…`
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
  const excerpt = lines
    .slice(1, end)
    .map((line) => line.replace(/^>\s?/, ''))
    .join('\n')
    .trim()
  const rest = lines.slice(end)
  // Only the blank line the quote format adds; the user's own leading whitespace stays.
  if (rest[0] === '') {
    rest.shift()
  }
  return {
    author: agentHead ? 'agent' : 'user',
    label: agentHead?.[1] ?? null,
    excerpt,
    rest: rest.join('\n')
  }
}
