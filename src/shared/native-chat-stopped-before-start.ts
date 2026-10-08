// A send a Stop took back before the agent started it: where it is drawn, and the one row after it.

import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import {
  agentJournalItemPosition,
  compareAgentJournalItems,
  compareAgentJournalPositions
} from './agent-session-journal-position'
import type {
  AgentJournalPosition,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import { inSendOrder } from './native-chat-send-order'
import { stoppedTurnOpeners, structuredAgentTurnAnchors } from './native-chat-turn-membership'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'

/** The row after a send a Stop took back before the agent started it; a client words it by this. */
export const NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION = 'stopped-before-start'
/** Its words where a client has no catalog of its own (the phone). */
export const NATIVE_CHAT_STOPPED_BEFORE_START_TEXT = 'Stopped manually'

/** That row: it outlives any turn it sits in, as the send it follows does. */
export function isStoppedBeforeStartBlock(block: NativeChatBlock): boolean {
  return (
    block.type === 'text' && block.presentation === NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION
  )
}

/** Where a send a Stop took back is drawn. `opensTurn`: a turn opened for it, whose interrupted
 *  end is its stop; `position`: where it is drawn, when that is not its own row. */
export type StoppedSendPlace = { opensTurn: boolean; position?: AgentJournalPosition }

/**
 * A send a Stop took back (`stopped`, by item id) is drawn at its own row, past the end of every
 * turn whose opener the journal wrote before it: a host that publishes `submittedSequence` puts
 * that row where the send was taken back. One that opened a turn is drawn as that turn's opener;
 * when that turn's record is not loaded, before the turn's first loaded row. Journal order only,
 * never a clock.
 * Temporary: a host that predates `submittedSequence` may leave the row where it was sent, so the
 * send is also drawn below the latest row sent before it (`latestRowsSentBefore`); harmless on one
 * that moves the row. Dropped once no supported remote host lacks the field.
 */
export function placeStoppedSends(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  stopped: ReadonlyMap<string, AgentJournalSubmission>
): (itemId: string) => StoppedSendPlace {
  const anchors = structuredAgentTurnAnchors(items, submissions)
  const turnOpenedBy = new Map([...anchors].map(([turnItemId, anchorId]) => [anchorId, turnItemId]))
  const itemsById = new Map(items.map((item) => [item.itemId, item]))
  const pastTurnsOpenedBefore = turnEndsByOpener(items, anchors, itemsById)
  const unloadedTurnOpened = unloadedTurnsOpened(items, itemsById, stopped)
  const sentBefore = [...stopped.values()].some(
    (submission) => submission.submittedSequence === undefined
  )
    ? latestRowsSentBefore(submissions, itemsById)
    : undefined
  return (itemId) => {
    const item = itemsById.get(itemId)
    if (!item) {
      return { opensTurn: false }
    }
    const own = agentJournalItemPosition(item)
    const record = itemsById.get(turnOpenedBy.get(itemId) ?? '')
    const opened = record ? openerPosition(item, record) : unloadedTurnOpened.get(itemId)
    if (opened) {
      // Drawn where its turn opened, as an opener is.
      return compareAgentJournalPositions(own, opened) !== 0
        ? { opensTurn: true, position: opened }
        : { opensTurn: true }
    }
    const floorRow = sentBefore?.get(itemId)
    const floor = floorRow ? agentJournalItemPosition(floorRow) : undefined
    // Just after the floor row, so a turn that row opened counts as waited on.
    const from =
      floor && compareAgentJournalPositions(floor, own) > 0
        ? { sequence: floor.sequence, index: floor.index + 0.5 }
        : own
    const position = pastTurnsOpenedBefore(from)
    return compareAgentJournalPositions(position, own) !== 0
      ? { opensTurn: false, position }
      : { opensTurn: false }
  }
}

/** Where a turn's opener is drawn: its own row, or just before the record when its row comes after
 *  it, as the row of a send taken back after its turn opened does. */
function openerPosition(
  opener: AgentJournalRenderItem,
  record: AgentJournalRenderItem
): AgentJournalPosition {
  const own = agentJournalItemPosition(opener)
  const opened = agentJournalItemPosition(record)
  return compareAgentJournalPositions(own, opened) > 0
    ? { sequence: opened.sequence, index: opened.index - 0.5 }
    : own
}

/** For each taken-back send that opened a turn whose record is not loaded (a page that starts inside
 *  that turn), just before the turn's first loaded row; none when a loaded user row is in it. */
function unloadedTurnsOpened(
  items: readonly AgentJournalRenderItem[],
  itemsById: ReadonlyMap<string, AgentJournalRenderItem>,
  stopped: ReadonlyMap<string, AgentJournalSubmission>
): ReadonlyMap<string, AgentJournalPosition> {
  const openers = new Map(
    [...stoppedTurnOpeners([...stopped.values()])].filter(
      ([turnItemId]) => !itemsById.has(turnItemId)
    )
  )
  const first = new Map<string, AgentJournalPosition | null>()
  for (const item of items) {
    const turnItemId = item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : undefined
    if (turnItemId === undefined || !openers.has(turnItemId) || first.has(turnItemId)) {
      continue
    }
    const userRow = item.body.kind === 'message' && item.body.role === 'user'
    const position = agentJournalItemPosition(item)
    first.set(turnItemId, userRow ? null : { ...position, index: position.index - 0.5 })
  }
  return new Map(
    [...openers].flatMap(([turnItemId, itemId]) => {
      const position = first.get(turnItemId)
      return position ? [[itemId, position] as const] : []
    })
  )
}

/**
 * For a point in the journal, just after the furthest row of every turn whose opener comes before
 * it, or the point itself when none reaches past it. One pass over the items, then a binary search
 * per point. A send placed here opened no turn, so no turn is its own.
 */
function turnEndsByOpener(
  items: readonly AgentJournalRenderItem[],
  anchors: ReadonlyMap<string, string>,
  itemsById: ReadonlyMap<string, AgentJournalRenderItem>
): (from: AgentJournalPosition) => AgentJournalPosition {
  const lastOfTurn = new Map<string, AgentJournalPosition>()
  const reach = (turnItemId: string, position: AgentJournalPosition): void => {
    const last = lastOfTurn.get(turnItemId)
    if (!last || compareAgentJournalPositions(position, last) > 0) {
      lastOfTurn.set(turnItemId, position)
    }
  }
  for (const item of items) {
    const position = agentJournalItemPosition(item)
    if (anchors.has(item.itemId)) {
      reach(item.itemId, position)
    }
    if (item.turnScope?.kind === 'turn') {
      reach(item.turnScope.turnItemId, position)
    }
  }
  const turns = [...anchors].flatMap(([turnItemId, anchorId]) => {
    const opener = itemsById.get(anchorId)
    const record = itemsById.get(turnItemId)
    const last = lastOfTurn.get(turnItemId)
    return opener && record && last ? [{ opener: openerPosition(opener, record), last }] : []
  })
  turns.sort((left, right) => compareAgentJournalPositions(left.opener, right.opener))
  // The furthest row of the turns opened up to each one.
  const furthest: AgentJournalPosition[] = []
  for (const turn of turns) {
    const previous = furthest.at(-1)
    furthest.push(
      previous && compareAgentJournalPositions(previous, turn.last) > 0 ? previous : turn.last
    )
  }
  return (from) => {
    let low = 0
    let high = turns.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (compareAgentJournalPositions(turns[middle]!.opener, from) < 0) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    const last = low > 0 ? furthest[low - 1]! : undefined
    return last && compareAgentJournalPositions(last, from) > 0
      ? { sequence: last.sequence, index: last.index + 0.5 }
      : from
  }
}

/** For each submission, the latest loaded row of the ones sent before it, in `submittedAt` order
 *  with ties kept in list order as the client reducer keeps them. Temporary: read only for a host
 *  that predates `submittedSequence`. */
function latestRowsSentBefore(
  submissions: readonly AgentJournalSubmission[],
  itemsById: ReadonlyMap<string, AgentJournalRenderItem>
): ReadonlyMap<string, AgentJournalRenderItem> {
  const byAcceptTime = submissions
    .map((submission, order) => ({ submission, order }))
    .sort(
      (left, right) =>
        left.submission.submittedAt - right.submission.submittedAt || left.order - right.order
    )
  const before = new Map<string, AgentJournalRenderItem>()
  let latest: AgentJournalRenderItem | undefined
  for (const { submission } of byAcceptTime) {
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    if (latest) {
      before.set(key, latest)
    }
    const row = itemsById.get(key)
    if (row && (!latest || compareAgentJournalItems(row, latest) > 0)) {
      latest = row
    }
  }
  return before
}

/**
 * Sends a Stop took back (`stopped`, by item id, in list order) and drawn on their own (`shown`)
 * keep the order they were sent in: a later one is drawn no earlier than just after an earlier
 * one. Sent order is the published `submittedSequence`.
 * Temporary, until a host version floor: a host that predates it gives `submittedAt`, its accept
 * time, with ties kept in list order as the client reducer keeps them. Returns whether it moved any.
 */
export function keepStoppedSendsInSendOrder(
  messages: NativeChatMessage[],
  stopped: ReadonlyMap<string, AgentJournalSubmission>,
  shown: ReadonlySet<string>
): boolean {
  const indexById = new Map<string, number>()
  messages.forEach((message, index) => {
    if (shown.has(message.id)) {
      indexById.set(message.id, index)
    }
  })
  const taken = [...stopped].flatMap(([itemId, submission]) => {
    const index = indexById.get(itemId)
    return index === undefined ? [] : [{ index, submission }]
  })
  const sent = inSendOrder(taken, ({ submission }) => submission)
  let floor: AgentJournalPosition | undefined
  let moved = false
  for (const { index } of sent) {
    const message = messages[index]!
    const position = message.journalPosition
    if (!position) {
      continue
    }
    if (floor && compareAgentJournalPositions(position, floor) <= 0) {
      floor = { sequence: floor.sequence, index: floor.index + 1 / 1024 }
      messages[index] = { ...message, journalPosition: floor }
      moved = true
    } else {
      floor = position
    }
  }
  return moved
}

/** One row after each run of sends a Stop took back (`stopped`, by id), placed with the last. */
export function withStopRowsAfterStoppedSends(
  messages: readonly NativeChatMessage[],
  stopped: ReadonlySet<string>
): NativeChatMessage[] {
  return messages.flatMap((message, index) =>
    stopped.has(message.id) && !stopped.has(messages[index + 1]?.id ?? '')
      ? [
          message,
          {
            id: `stopped-before-start:${message.id}`,
            role: 'system' as const,
            source: 'transcript' as const,
            timestamp: message.timestamp,
            blocks: [
              {
                type: 'text' as const,
                text: NATIVE_CHAT_STOPPED_BEFORE_START_TEXT,
                presentation: NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION
              }
            ],
            ...(message.journalPosition ? { journalPosition: message.journalPosition } : {})
          }
        ]
      : [message]
  )
}
