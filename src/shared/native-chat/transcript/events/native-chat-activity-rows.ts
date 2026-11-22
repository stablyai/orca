// One-line activity rows (item lines, a worker's update, a Started row) sit close where two meet, on the
// desktop and the phone alike; anything else (a bubble, the agent's words, a turn's bar or diff) keeps
// the transcript's row gap.
import type { NativeChatMessage } from '../../native-chat-types'
import { botItemNoteIsQuiet } from '../../../bots/bot-item-note-lines'
import { rowDrawsNothing } from '../../../bots/bot-item-note-runs'

export type NativeChatActivityEdges = { top: boolean; bottom: boolean }

const NO_EDGES: NativeChatActivityEdges = { top: false, bottom: false }
const BOTH_EDGES: NativeChatActivityEdges = { top: true, bottom: true }

/** Whether a row's first and last drawn things are activity rows. A note draws its quiet lines first
 *  and the owner's comments after them, as messages. */
export function nativeChatActivityEdges(message: NativeChatMessage): NativeChatActivityEdges {
  const note = message.botItemNote
  if (note) {
    return botItemNoteIsQuiet(note)
      ? BOTH_EDGES
      : { top: note.entries.some((entry) => entry.event === 'status'), bottom: false }
  }
  return message.from !== undefined && (message.role === 'user' || message.agentStart === true)
    ? BOTH_EDGES
    : NO_EDGES
}

export type NativeChatActivityJoin = 'above' | 'below' | 'both'

/** Which sides of each activity row touch another, so the two sit close: the nearest row that draws,
 *  past folded and hidden ones (`hidden`: what this surface folded away). `apart`: what the row draws
 *  above or below itself (a turn's bar or diff), which keeps that side apart. */
export function nativeChatActivityRowJoins(
  messages: readonly NativeChatMessage[],
  hidden: (index: number) => boolean,
  apart: (index: number) => { above?: boolean; below?: boolean } = () => ({})
): Map<number, NativeChatActivityJoin> {
  const drawn = messages.flatMap((message, index) =>
    hidden(index) || rowDrawsNothing(message) ? [] : [index]
  )
  const edges = drawn.map((index) => {
    const own = nativeChatActivityEdges(messages[index]!)
    const kept = apart(index)
    return { top: own.top && !kept.above, bottom: own.bottom && !kept.below }
  })
  const joins = new Map<number, NativeChatActivityJoin>()
  drawn.forEach((index, at) => {
    const above = edges[at]!.top && edges[at - 1]?.bottom === true
    const below = edges[at]!.bottom && edges[at + 1]?.top === true
    if (above || below) {
      joins.set(index, above && below ? 'both' : above ? 'above' : 'below')
    }
  })
  return joins
}
