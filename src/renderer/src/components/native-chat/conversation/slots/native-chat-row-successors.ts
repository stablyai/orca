// Consecutive tool calls read as one row that takes its first call's id, so when an older page
// brings a run's earlier calls, the row the reader saw is folded into an earlier one and its id
// is gone. Its calls are not: follow them to the row that holds them now.

import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

/** The named tool calls in a row; an unnamed or blank call can't be followed. */
function callIds(message: NativeChatMessage): string[] {
  return message.blocks.flatMap((block) =>
    block.type === 'tool-call' && block.callId !== undefined && block.callId.trim() !== ''
      ? [block.callId]
      : []
  )
}

/**
 * Each of `ids` (rows of the `previous` read) mapped to the row of the `current` read that holds
 * it: itself when it is still there, else the one row now holding all of its named tool calls.
 * Absent when there is no such single row: no named calls, a call two current rows both name, or
 * calls split across rows. Linear in both reads, and reads either only when an id is gone.
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
  // A call two current rows both name could be either one: it leads nowhere.
  const callOwners = new Map<string, string | null>()
  for (const message of current) {
    for (const callId of callIds(message)) {
      const owner = callOwners.get(callId)
      callOwners.set(callId, owner === undefined || owner === message.id ? message.id : null)
    }
  }
  for (const id of gone) {
    const message = previousById.get(id)
    const calls = message ? callIds(message) : []
    const owners = new Set(calls.map((callId) => callOwners.get(callId) ?? null))
    const [owner] = owners
    if (calls.length > 0 && owners.size === 1 && owner !== null && owner !== undefined) {
      successors.set(id, owner)
    }
  }
  return successors
}
