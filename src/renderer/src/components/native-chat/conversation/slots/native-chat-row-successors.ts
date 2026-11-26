// Consecutive tool calls read as one row that takes its first call's id, so when an older page
// brings a run's earlier calls, the row the reader saw is folded into an earlier one and its id
// is gone. Its calls are not: follow them to the row that holds them now.

import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

/** The named tool calls in a row; an unnamed call can't be followed. */
function callIds(message: NativeChatMessage): string[] {
  return message.blocks.flatMap((block) =>
    block.type === 'tool-call' && block.callId !== undefined ? [block.callId] : []
  )
}

/**
 * Each of `ids` (rows of the `previous` read) mapped to the row of the `current` read that holds
 * it: itself when it is still there, else the row now holding its first tool call. Rows with no
 * such successor are absent. Linear in both reads, and only reads either when an id is gone.
 */
export function nativeChatRowSuccessors(
  previous: readonly NativeChatMessage[],
  current: readonly NativeChatMessage[],
  ids: Iterable<string>
): ReadonlyMap<string, string> {
  const present = new Set(current.map((message) => message.id))
  const successors = new Map<string, string>()
  const gone: string[] = []
  for (const id of ids) {
    if (present.has(id)) {
      successors.set(id, id)
    } else {
      gone.push(id)
    }
  }
  if (gone.length === 0) {
    return successors
  }
  const previousById = new Map(previous.map((message) => [message.id, message]))
  const callOwners = new Map<string, string>()
  for (const message of current) {
    for (const callId of callIds(message)) {
      callOwners.set(callId, message.id)
    }
  }
  for (const id of gone) {
    const message = previousById.get(id)
    const owner = message
      ? callIds(message)
          .map((callId) => callOwners.get(callId))
          .find((candidate) => candidate !== undefined)
      : undefined
    if (owner !== undefined) {
      successors.set(id, owner)
    }
  }
  return successors
}
