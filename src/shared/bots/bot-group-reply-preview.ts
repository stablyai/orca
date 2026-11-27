import type { BotGroupTurn } from './bot-group-schema'
import { isQuietBotResult, quietBotResultText } from '../bot-quiet-result'
import type { NativeChatMessage } from '../native-chat/native-chat-types'

const WORD_CHARACTER = /[\p{L}\p{N}]/u

/** An answer of `42` is only held when it appears as a whole word, outside `142 files`. */
function holdsAnswer(words: string, answer: string): boolean {
  const said = answer.trim()
  for (let at = words.indexOf(said); at !== -1; at = words.indexOf(said, at + 1)) {
    const before = words[at - 1] ?? ''
    const after = words[at + said.length] ?? ''
    if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) {
      return true
    }
  }
  return false
}

/** A turn's reply as room history: its answer to a member's request added unless the reply
 *  already says it, and a quiet reply's marker dropped. Null when neither has words. */
export function botGroupTurnReplyText(
  reply: string | null | undefined,
  answer: string | undefined
): string | null {
  const said = reply && isQuietBotResult(reply) ? quietBotResultText(reply) : (reply ?? '')
  if (!answer?.trim() || holdsAnswer(said, answer)) {
    return said || null
  }
  return said ? `${said}\n\n${answer}` : answer
}

/** The most of a saved reply a room page carries per turn; the turn's own rows hold the rest. */
export const BOT_GROUP_PAGE_REPLY_MAX = 4_000
export const BOT_GROUP_SAVED_REPLY_MAX = 16_000

const FENCE = /^ {0,3}(`{3,}(?!`)|~{3,}(?!~))(.*)$/

/** The fence of the code block `text` leaves open, if any: a block closes only on a bare fence of its
 *  own character at least as long, so a longer block may hold shorter fences. */
export function botGroupOpenFence(text: string, previous: string | null = null): string | null {
  let open = previous
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(start, end)
    start = end + 1
    const match = FENCE.exec(line)
    if (!match) {
      continue
    }
    const [, fence, info] = match
    if (open === null && (fence[0] !== '`' || !info.includes('`'))) {
      open = fence
    } else if (open && fence[0] === open[0] && fence.length >= open.length && !info.trim()) {
      open = null
    }
  }
  return open
}

const CUT_PREFIX = '…\n\n'

function tailFromLine(reply: string, budget: number): string {
  const start = Math.max(0, reply.length - budget)
  const tail = reply.slice(start)
  const newline = tail.indexOf('\n')
  const wholeLines =
    newline !== -1 && start > 0 && reply[start - 1] !== '\n' ? tail.slice(newline + 1) : tail
  return wholeLines.trim() ? wholeLines : tail
}

/** Keep a whole-line tail and restore the fence state at the cut. */
export function botGroupPageReply(reply: string): string {
  return reply.length <= BOT_GROUP_PAGE_REPLY_MAX ? reply : botGroupPageReplyParts([reply])
}

export function botGroupPageReplyParts(parts: readonly string[]): string {
  const chunks = parts.flatMap((part, index) => (index === 0 ? [part] : ['\n\n', part]))
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  if (length <= BOT_GROUP_PAGE_REPLY_MAX) {
    return chunks.join('')
  }
  // Normal fences need at most 16 characters of delimiter. Longer delimiters are represented as
  // indented code so a delimiter cannot itself overrun the preview.
  const limit = BOT_GROUP_PAGE_REPLY_MAX - CUT_PREFIX.length - 21
  let wanted = limit + 1
  const tails: string[] = []
  for (let index = chunks.length - 1; index >= 0 && wanted > 0; index--) {
    const tail = chunks[index].slice(-wanted)
    tails.push(tail)
    wanted -= tail.length
  }
  const rest = tailFromLine(tails.toReversed().join(''), limit)
  let before = length - rest.length
  let fence: string | null = null
  for (const chunk of chunks) {
    if (before <= 0) {
      break
    }
    const prefix =
      before >= chunk.length ? chunk : chunk.slice(0, chunk.lastIndexOf('\n', before - 1) + 1)
    fence = botGroupOpenFence(prefix, fence)
    before -= chunk.length
  }
  if (!fence) {
    return CUT_PREFIX + rest
  }
  if (fence.length <= 16) {
    return `${CUT_PREFIX}${fence}text\n${rest}`
  }
  const lines = rest.split('\n')
  const closing = lines.findIndex((line) => {
    const match = FENCE.exec(line)
    return (
      !!match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()
    )
  })
  const code = closing === -1 ? lines : lines.slice(0, closing)
  const prose = closing === -1 ? '' : lines.slice(closing + 1).join('\n')
  let budget = BOT_GROUP_PAGE_REPLY_MAX - CUT_PREFIX.length - prose.length - 2
  const kept: string[] = []
  for (const line of code.toReversed()) {
    if (budget <= 5) {
      break
    }
    const text = `    ${line.slice(-(budget - 5))}`
    kept.push(text)
    budget -= text.length + 1
  }
  return CUT_PREFIX + kept.toReversed().join('\n') + (prose ? `\n\n${prose}` : '')
}

/** An ended turn's rows hold neither words nor work (a tool call, a subagent): it ended without a
 *  reply, as the room says under it. */
export function botGroupTurnShowsNothing(messages: readonly NativeChatMessage[]): boolean {
  return !messages.some((message) =>
    message.blocks.some((block) => block.type !== 'text' || block.text.trim())
  )
}

/** A turn's rows as the room draws them on desktop and mobile: its answer to a member's request
 *  closes them, unless its own words already said it. An ended turn whose loaded rows hold none of
 *  its words draws its saved reply instead. */
export function withBotGroupTurnAnswer(
  messages: NativeChatMessage[],
  turn: Pick<BotGroupTurn, 'operationId' | 'answer' | 'reply' | 'endedAt'>,
  replyAheadOfJournal = false
): NativeChatMessage[] {
  const words = messages
    .flatMap((message) =>
      message.role === 'assistant'
        ? message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
    .join('\n')
  const answer =
    words.trim() && !replyAheadOfJournal
      ? turn.answer
      : turn.answer
        ? (botGroupTurnReplyText(turn.reply, turn.answer) ?? undefined)
        : turn.reply
  return answer?.trim() && !holdsAnswer(words, answer)
    ? [
        ...messages,
        {
          id: `${turn.operationId}:answer`,
          role: 'assistant',
          blocks: [{ type: 'text', text: answer }],
          timestamp: turn.endedAt ?? null,
          source: 'transcript'
        }
      ]
    : messages
}
