import {
  noteRevisedInPlace,
  revisedInPlace
} from '../../../agent-session/view/revised-in-place-lists'
// Share desktop/mobile turn ownership, bar placement and row order.

import type { AgentJournalRenderItem } from '../../../agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../agent-session/lifecycle/records/agent-session-turn-record'
import type { NativeChatMessage, NativeChatRole } from '../../native-chat-types'
import { isNativeChatProviderTurnStart } from './native-chat-provider-turn-start'

type NativeChatTurnRow = { id: string; role: NativeChatRole }

export type NativeChatTurnMember = Pick<
  NativeChatMessage,
  'id' | 'role' | 'blocks' | 'unsent' | 'journalPosition'
>

/** Which rows can open a turn by themselves: in a conversation, its user rows. */
export type NativeChatOpensTurn = (message: NativeChatTurnRow) => boolean

export const nativeChatUserRowOpensTurn: NativeChatOpensTurn = (message) => message.role === 'user'

/** Host turn attribution wins over mid-turn send position. Unmapped rows use preceding-user grouping;
 * opensTurn restricts which unmapped rows can anchor turns in interleaved streams. */
export function nativeChatRowTurnKeys<Row extends NativeChatTurnRow>(
  messages: readonly Row[],
  turnKeysByItemId?: ReadonlyMap<string, string> | null,
  opensTurn: (message: Row) => boolean = nativeChatUserRowOpensTurn
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

/** Without turn records, the host marks where the agent resumed on its own, and that opens a turn too. */
export function nativeChatPositionalTurnKeys(
  messages: readonly NativeChatTurnMember[],
  opensTurn: NativeChatOpensTurn
): (string | undefined)[] {
  return nativeChatRowTurnKeys(
    messages,
    null,
    (message) => opensTurn(message) || isNativeChatProviderTurnStart(message)
  )
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
  const moved = new Map<number, number>()
  const waiting = new Set<number>()
  const waitingByTurn = new Map<string, number[]>()
  let lastContentRow = -1
  const finish = (index: number): void => {
    if (waiting.delete(index) && lastContentRow > index) {
      moved.set(index, lastContentRow)
    }
  }
  for (const [index, message] of messages.entries()) {
    if (opensTurn(index)) {
      waiting.add(index)
      const turn = waitingByTurn.get(message.id)
      if (turn) {
        turn.push(index)
      } else {
        waitingByTurn.set(message.id, [index])
      }
      continue
    }
    const turnKey = turnKeys[index]
    if (turnKey === undefined) {
      continue
    }
    const first = firstRow.get(turnKey) ?? index
    for (const openerIndex of waiting) {
      if (openerIndex >= first) {
        break
      }
      finish(openerIndex)
    }
    for (const openerIndex of waitingByTurn.get(turnKey) ?? []) {
      finish(openerIndex)
    }
    waitingByTurn.delete(turnKey)
    lastContentRow = index
  }
  for (const index of waiting) {
    finish(index)
  }
  if (moved.size === 0) {
    return null
  }
  const movedAfter = new Map<number, number[]>()
  for (let index = 0; index < messages.length; index += 1) {
    const after = moved.get(index)
    if (after === undefined) {
      continue
    }
    const indexes = movedAfter.get(after)
    if (indexes) {
      indexes.push(index)
    } else {
      movedAfter.set(after, [index])
    }
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

// Per reordered list: the order it was drawn in, what that gave, and each row's drawn place.
const drawnRows = new WeakMap<
  readonly object[],
  { drawOrder: readonly number[]; drawn: readonly object[]; placeOf: readonly number[] }
>()

/** `nativeChatRowsInDrawOrder` for a list a streaming reply revises in place: a revision of a list
 *  already reordered the same way replaces only its revised rows, and stays linked to it. */
export function nativeChatRevisedRowsInDrawOrder<T extends object>(
  rows: readonly T[],
  drawOrder: readonly number[] | null
): readonly T[] {
  if (drawOrder === null) {
    return rows
  }
  const revision = revisedInPlace(rows)
  const prior = revision && drawnRows.get(revision.from)
  let drawn: T[]
  let placeOf: readonly number[]
  if (revision && prior?.drawOrder === drawOrder) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only reorders of one row type are cached.
    drawn = (prior.drawn as readonly T[]).slice()
    placeOf = prior.placeOf
    const positions: number[] = []
    for (const index of revision.at) {
      const place = placeOf[index]!
      drawn[place] = rows[index]!
      positions.push(place)
    }
    noteRevisedInPlace(drawn, prior.drawn, positions)
  } else {
    drawn = drawOrder.map((index) => rows[index]!)
    const places: number[] = []
    drawOrder.forEach((index, place) => {
      places[index] = place
    })
    placeOf = places
  }
  drawnRows.set(rows, { drawOrder, drawn, placeOf })
  return drawn
}
