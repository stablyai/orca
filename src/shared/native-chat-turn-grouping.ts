// Which turn each transcript row belongs to, and where a turn with no user
// bubble anchors its bar. Shared because desktop and mobile both group rows and
// place bars from these keys, and a row grouped differently on each surface is
// the same bug twice.

import type { NativeChatMessage } from './native-chat-types'

/**
 * Resolve each row's turn key. The host's attribution (`turnKeysByItemId`, from
 * `selectStructuredAgentTurnBars`) wins, so rows after a mid-turn send stay with
 * the turn that produced them. Rows it cannot name keep positional grouping —
 * an unmapped user row keys itself, anything else inherits the previous row's
 * key — which on a host without turn attribution is exactly today's
 * preceding-user-message grouping.
 */
export function nativeChatRowTurnKeys(
  messages: readonly NativeChatMessage[],
  turnKeysByItemId?: ReadonlyMap<string, string> | null
): (string | undefined)[] {
  let currentTurnKey: string | undefined
  return messages.map((message) => {
    const owned = turnKeysByItemId?.get(message.id)
    if (owned !== undefined) {
      currentTurnKey = owned
      return owned
    }
    if (message.role === 'user') {
      currentTurnKey = message.id
    }
    return currentTurnKey
  })
}

/** For each turn key with no message of its own — a turn the provider opened, or
 *  whose opener is outside the loaded window — the row index that anchors its
 *  bar: the turn's first rendered row, matching the turn's own position. */
export function nativeChatSelfAnchoredTurnRows(
  messages: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[]
): ReadonlyMap<string, number> {
  const messageIds = new Set(messages.map((message) => message.id))
  const anchors = new Map<string, number>()
  turnKeys.forEach((turnKey, index) => {
    if (turnKey !== undefined && !messageIds.has(turnKey) && !anchors.has(turnKey)) {
      anchors.set(turnKey, index)
    }
  })
  return anchors
}
