import { groupedBy } from '../collections/grouped-by'
import type { BotGroupMessage } from './bot-group-schema'

type MailLine = Pick<BotGroupMessage, 'turns' | 'requester' | 'answeredBy'>
type Line = MailLine &
  Pick<BotGroupMessage, 'id' | 'sequence' | 'rootRequestId' | 'rootSequence' | 'mailReplyOrder'>

export function isBotGroupWorkerOrItemMail(line: MailLine): boolean {
  return line.turns[0]?.mailbox === true && !line.requester && !line.answeredBy
}

/** A room page in reading order. Peer mail, @Name hand-offs and paused lines follow their
 *  original post, or lead the page when that post is older. Worker and item replies use the
 *  position reserved when they finished. */
export function botGroupRoomOrder<T extends Line>(messages: readonly T[]): T[] {
  const rootOf = (line: T) =>
    line.rootRequestId !== undefined &&
    line.rootRequestId !== line.id &&
    !isBotGroupWorkerOrItemMail(line)
      ? line.rootRequestId
      : null
  const loaded = new Set(messages.map((line) => line.id))
  const continuing = groupedBy(
    messages.filter((line) => rootOf(line) !== null),
    (line) => rootOf(line) ?? ''
  )
  const earlier = [...continuing]
    .filter(([root]) => !loaded.has(root))
    .sort(
      ([, left], [, right]) =>
        (left[0]?.rootSequence ?? left[0]?.sequence ?? 0) -
        (right[0]?.rootSequence ?? right[0]?.sequence ?? 0)
    )
    .flatMap(([, lines]) => lines)
  return [
    ...earlier,
    ...messages
      .filter((line) => rootOf(line) === null)
      .sort(
        (left, right) =>
          (left.mailReplyOrder?.after ?? left.sequence) -
            (right.mailReplyOrder?.after ?? right.sequence) ||
          (left.mailReplyOrder?.reply ?? -1) - (right.mailReplyOrder?.reply ?? -1)
      )
      .flatMap((line) => [line, ...(continuing.get(line.id) ?? [])])
  ]
}
