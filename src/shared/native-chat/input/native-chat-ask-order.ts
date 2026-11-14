import { compareAgentJournalPositions } from '../../agent-session/journal/agent-session-journal-position'
import type { NativeChatMessage } from '../native-chat-types'

/** Held rows render at the tail, but questions follow their current journal positions. */
export function* nativeChatAskScanOrder(
  messages: readonly NativeChatMessage[]
): Iterable<NativeChatMessage> {
  const ordered: NativeChatMessage[] = []
  const displaced: NativeChatMessage[] = []
  let previous: NativeChatMessage['journalPosition']
  for (const message of messages) {
    const position = message.journalPosition
    if (position && previous && compareAgentJournalPositions(position, previous) < 0) {
      displaced.push(message)
    } else {
      ordered.push(message)
      if (position) {
        previous = position
      }
    }
  }
  displaced.sort((a, b) => compareAgentJournalPositions(a.journalPosition!, b.journalPosition!))
  let next = 0
  for (const message of ordered) {
    while (
      message.journalPosition &&
      next < displaced.length &&
      compareAgentJournalPositions(displaced[next]!.journalPosition!, message.journalPosition) < 0
    ) {
      yield displaced[next++]!
    }
    yield message
  }
  yield* displaced.slice(next)
}
