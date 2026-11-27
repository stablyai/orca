import { groupedBy } from '../collections/grouped-by'
import type { BotGroupMessage } from './bot-group-schema'

type Line = Pick<BotGroupMessage, 'id' | 'sequence' | 'rootRequestId' | 'rootSequence'>

/** A room page in reading order: every line that continues a person's post (peer mail, @Name
 *  hand-offs, the paused line) follows that post, in stored order. Lines whose post is on an
 *  earlier page lead the page, one post's lines together, oldest post first. */
export function botGroupRoomOrder<T extends Line>(messages: readonly T[]): T[] {
  const rootOf = (line: T) =>
    line.rootRequestId !== undefined && line.rootRequestId !== line.id ? line.rootRequestId : null
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
    ...messages.flatMap((line) =>
      rootOf(line) === null ? [line, ...(continuing.get(line.id) ?? [])] : []
    )
  ]
}
