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
  for (const line of text.split('\n')) {
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

export function botGroupSavedReplyFence(full: string): string | undefined {
  const start = full.length - BOT_GROUP_SAVED_REPLY_MAX
  if (start <= 0) {
    return undefined
  }
  const beforeLine = full.lastIndexOf('\n', start - 1) + 1
  return botGroupOpenFence(full.slice(0, beforeLine)) ?? undefined
}

/** `reply`'s last `max` characters from a whole line (mid-line only when one line is longer), after
 *  "…"; a code block the cut began inside is reopened as plain text, so the rest still reads as code. */
function botGroupReplyTail(reply: string, max: number, savedFence?: string): string {
  if (reply.length <= max && !savedFence) {
    return reply
  }
  const start = Math.max(0, reply.length - max)
  const end = reply.slice(start)
  const newline = end.indexOf('\n')
  const fromLine =
    newline !== -1 && start > 0 && reply[start - 1] !== '\n' ? end.slice(newline + 1) : end
  const rest = fromLine.trim() ? fromLine : end
  const prefix = reply.slice(0, reply.length - rest.length)
  const open = botGroupOpenFence(prefix.slice(0, prefix.lastIndexOf('\n') + 1), savedFence ?? null)
  return `…\n\n${open ? `${open}text\n` : ''}${rest}`
}

/** A saved reply as a room page carries it. */
export function botGroupPageReply(reply: string, savedFence?: string): string {
  return botGroupReplyTail(reply, BOT_GROUP_PAGE_REPLY_MAX, savedFence)
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
  turn: Pick<BotGroupTurn, 'operationId' | 'answer' | 'reply' | 'endedAt'>
): NativeChatMessage[] {
  const words = messages
    .flatMap((message) =>
      message.role === 'assistant'
        ? message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
    .join('\n')
  const answer = words.trim()
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
