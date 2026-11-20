import type { BotGroupMessage } from './bot-group-schema'

type Line = Pick<BotGroupMessage, 'id' | 'author' | 'rootRequestId' | 'mentioned' | 'pausedAfter'>

/** A room page in reading order: each @Name hand-off and paused line moves to the end of the
 *  person's post it continues (before the next person's post); one whose post is on an earlier
 *  page ends the lines that lead the page. Everything else keeps its stored order. */
export function botGroupRoomOrder<T extends Line>(messages: readonly T[]): T[] {
  const continues = (line: T) =>
    (line.mentioned === true || line.pausedAfter !== undefined) && line.rootRequestId !== undefined
  const posts = new Set(messages.flatMap((line) => (line.author.kind === 'owner' ? [line.id] : [])))
  // The page's leading lines answer a post on an earlier page; keyed by the empty id.
  const held = Map.groupBy(messages.filter(continues), (line) =>
    posts.has(line.rootRequestId ?? '') ? (line.rootRequestId ?? '') : ''
  )
  const ordered: T[] = []
  let block = ''
  for (const line of messages) {
    if (line.author.kind === 'owner') {
      ordered.push(...(held.get(block) ?? []))
      block = line.id
    }
    if (!continues(line)) {
      ordered.push(line)
    }
  }
  ordered.push(...(held.get(block) ?? []))
  return ordered
}
