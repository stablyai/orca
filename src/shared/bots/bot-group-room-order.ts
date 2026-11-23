import type { BotGroupMessage } from './bot-group-schema'

type Line = Pick<BotGroupMessage, 'id' | 'sequence' | 'rootRequestId' | 'rootSequence'>

/** A room page in reading order: every line that continues a person's post (peer mail, @Name
 *  hand-offs, the paused line) follows that post, in stored order. Lines whose post is on an
 *  earlier page lead the page, one post's lines together, oldest post first. */
export function botGroupRoomOrder<T extends Line>(messages: readonly T[]): T[] {
  const rootOf = (line: T) =>
    line.rootRequestId !== undefined && line.rootRequestId !== line.id ? line.rootRequestId : null
  const loaded = new Set(messages.map((line) => line.id))
  // Not Map.groupBy: the paired phone page runs this, and WebKit before iOS 17.4 lacks it.
  const continuing = new Map<string, T[]>()
  for (const line of messages) {
    const root = rootOf(line)
    const lines = root === null ? undefined : continuing.get(root)
    if (lines) {
      lines.push(line)
    } else if (root !== null) {
      continuing.set(root, [line])
    }
  }
  const earlier = [...continuing]
    .filter(([root]) => !loaded.has(root))
    .toSorted(
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
