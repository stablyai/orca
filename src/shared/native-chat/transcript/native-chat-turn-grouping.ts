// Share desktop/mobile turn ownership, bar placement and row order.

import type { AgentJournalRenderItem } from '../../agent-session-journal-types'
import { readAgentJournalTurn } from '../../agent-session-turn-record'
import type { NativeChatRole } from '../../native-chat-types'

type NativeChatTurnRow = { id: string; role: NativeChatRole }

/** Which rows can open a turn by themselves: in a conversation, its user rows. */
export type NativeChatOpensTurn = (message: NativeChatTurnRow) => boolean

export const nativeChatUserRowOpensTurn: NativeChatOpensTurn = (message) => message.role === 'user'

/** Host turn attribution wins over mid-turn send position. Unmapped rows use preceding-user grouping;
 * opensTurn restricts which unmapped rows can anchor turns in interleaved streams. */
export function nativeChatRowTurnKeys(
  messages: readonly NativeChatTurnRow[],
  turnKeysByItemId?: ReadonlyMap<string, string> | null,
  opensTurn: NativeChatOpensTurn = nativeChatUserRowOpensTurn
): (string | undefined)[] {
  let currentTurnKey: string | undefined
  return messages.map((message) => {
    const owned = turnKeysByItemId?.get(message.id)
    if (owned !== undefined) {
      currentTurnKey = owned
      return owned
    }
    if (opensTurn(message)) {
      currentTurnKey = message.id
    }
    return currentTurnKey
  })
}

/** Legacy unscoped hosts assign rows between root records to that turn’s mapped opener. Openers key themselves;
 * steers inherit only after later turn content proves continuation, so fresh tail sends keep waiting. Rows before the first record remain unmapped. */
export function nativeChatJournalOrderTurnKeys(
  items: readonly AgentJournalRenderItem[],
  recordKeys: ReadonlyMap<string, string | null>
): ReadonlyMap<string, string> {
  const openers = new Set([...recordKeys.values()].filter((key) => key !== null))
  const keys = new Map<string, string>()
  let currentKey: string | null = null
  // User items folded into the current turn, held until a later row proves the turn continued.
  let pendingUserItemIds: string[] = []
  for (const item of items) {
    if (recordKeys.has(item.itemId)) {
      currentKey = recordKeys.get(item.itemId) ?? null
      pendingUserItemIds = []
      continue
    }
    if (readAgentJournalTurn(item.body)) {
      continue
    }
    if (item.body.kind === 'message' && item.body.role === 'user') {
      if (openers.has(item.itemId)) {
        keys.set(item.itemId, item.itemId)
      } else if (currentKey !== null) {
        pendingUserItemIds.push(item.itemId)
      }
      continue
    }
    if (currentKey !== null) {
      for (const userItemId of pendingUserItemIds) {
        keys.set(userItemId, currentKey)
      }
      pendingUserItemIds = []
      keys.set(item.itemId, currentKey)
    }
  }
  return keys
}

/** Place each turn bar at its first row; use an above-row bar when the provider opened it or its user opener is unloaded. */
export function nativeChatTurnBarRows(
  messages: readonly { id: string }[],
  turnKeys: readonly (string | undefined)[]
): ReadonlyMap<string, { index: number; above: boolean }> {
  const bars = new Map<string, { index: number; above: boolean }>()
  turnKeys.forEach((turnKey, index) => {
    if (turnKey !== undefined && !bars.has(turnKey)) {
      bars.set(turnKey, { index, above: messages[index]?.id !== turnKey })
    }
  })
  return bars
}

/** Return draw indexes or null for journal order. Provider-queued sends are written mid-turn but open only after earlier work ends;
 * draw each opener after that prior work and just before its own turn’s rows. */
export function nativeChatTurnDrawOrder(
  messages: readonly NativeChatTurnRow[],
  turnKeys: readonly (string | undefined)[],
  openers: ReadonlySet<string>
): number[] | null {
  const opensTurn = (index: number): boolean =>
    messages[index]?.role === 'user' &&
    turnKeys[index] === messages[index].id &&
    openers.has(messages[index].id)
  const firstRow = new Map<string, number>()
  turnKeys.forEach((turnKey, index) => {
    if (turnKey !== undefined && !firstRow.has(turnKey)) {
      firstRow.set(turnKey, index)
    }
  })
  const movedAfter = new Map<number, number[]>()
  const moved = new Set<number>()
  for (const [index, message] of messages.entries()) {
    if (!opensTurn(index)) {
      continue
    }
    let after = -1
    for (let row = index + 1; row < messages.length; row += 1) {
      const turnKey = turnKeys[row]
      if (turnKey === undefined || opensTurn(row)) {
        continue
      }
      // Its own turn's rows, or a later turn's, end the earlier turns' rows it waited behind.
      if (turnKey === message.id || (firstRow.get(turnKey) ?? row) > index) {
        break
      }
      after = row
    }
    if (after !== -1) {
      moved.add(index)
      movedAfter.set(after, [...(movedAfter.get(after) ?? []), index])
    }
  }
  if (moved.size === 0) {
    return null
  }
  return messages.flatMap((_, index) => [
    ...(moved.has(index) ? [] : [index]),
    ...(movedAfter.get(index) ?? [])
  ])
}

/** `rows` in the transcript's draw order. */
export function nativeChatRowsInDrawOrder<T>(
  rows: readonly T[],
  drawOrder: readonly number[] | null
): readonly T[] {
  return drawOrder === null ? rows : drawOrder.map((index) => rows[index]!)
}
