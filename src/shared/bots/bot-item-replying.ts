// Which question a pending item reply answers, before the host's read says so.
import type { BotItemPendingComment } from './bot-item-pending-comments'

type BotItemReply = Pick<BotItemPendingComment, 'failed' | 'plain' | 'origin' | 'intent'>

/** The question a reply on its way answers: null when it answers none (failed, or a plain comment),
 *  undefined when that isn't known (an older path), which counts for whichever question waits. */
function botItemReplyOrigin(entry: BotItemReply): string | null | undefined {
  return entry.failed || entry.plain ? null : (entry.origin ?? entry.intent?.askId)
}

/** A reply on its way that answers `askId`, before the host's read says so: one sent for that ask.
 *  A plain comment answers none, and one sent for another ask (a replaced one) isn't this one's;
 *  a reply with no origin known (an older path) counts, as every reply used to. */
export function isBotItemReplyingTo(entry: BotItemReply, askId: string | null): boolean {
  const origin = botItemReplyOrigin(entry)
  return origin === undefined || (origin !== null && origin === askId)
}

/** The questions replies on their way answer, read once for a whole list: `unknown` when one's
 *  question isn't known, so it answers any. */
export function botItemRepliedAsks(entries: readonly BotItemReply[]): {
  unknown: boolean
  asks: ReadonlySet<string>
} {
  const asks = new Set<string>()
  let unknown = false
  for (const entry of entries) {
    const origin = botItemReplyOrigin(entry)
    if (origin === undefined) {
      unknown = true
    } else if (origin !== null) {
      asks.add(origin)
    }
  }
  return { unknown, asks }
}
