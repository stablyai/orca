import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import type { AgentSessionHistoryPage, AgentSessionTurnActivity } from '../agent-session-wire'
import type { AgentSessionBackgroundTaskState } from '../background-tasks/agent-session-background-task-wire'
import type {
  StructuredAgentHostClock,
  StructuredAgentSessionState
} from './live-read/structured-agent-session-reducer'
import { compareAgentJournalItems } from '../journal/agent-session-journal-position'
import {
  MAX_RETAINED_ITEMS,
  MAX_RETAINED_OWN_ITEMS,
  ownItemCount
} from './structured-agent-session-item-retention'
import { foldStructuredAgentSubagentRosterPage } from './structured-agent-session-subagent-roster'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import {
  noteStreamedTextRevision,
  onlyStreamedTextChanged
} from './structured-agent-session-streamed-text-rows'
import { noteRevisedInPlace } from './revised-in-place-lists'
import { admitAgentSessionBackgroundTaskState } from '../background-tasks/agent-session-background-task-state-admission'
import { agentSessionHasOlderTranscript } from '../conversation-context/agent-session-context-clear'

/** A frame without `hostNow` (older host) leaves the previous sample in place. */
export function hostClockField(
  hostNow: number | undefined,
  receivedAt: number,
  previous: StructuredAgentHostClock | undefined
): { hostClock?: StructuredAgentHostClock } {
  const hostClock = hostNow !== undefined ? { hostNow, receivedAt } : previous
  return hostClock ? { hostClock } : {}
}

export function replacePage(
  page: AgentSessionHistoryPage,
  fence: number | null,
  backgroundTasks?: AgentSessionBackgroundTaskState | null,
  activity?: AgentSessionTurnActivity | null
): StructuredAgentSessionState {
  return {
    epoch: page.epoch,
    cursor: page.liveCursor ?? page.window.nextCursor,
    fence,
    items: [...page.items].sort(compareAgentJournalItems),
    submissions: page.submissions,
    retainedOwnItemLimit: Math.max(MAX_RETAINED_OWN_ITEMS, ownItemCount(page.items)),
    retainedItemCap: Math.max(MAX_RETAINED_ITEMS, page.items.length),
    hasOlder: agentSessionHasOlderTranscript(page.items, page.hasOlder),
    status: 'ready',
    subagentRoster: foldStructuredAgentSubagentRosterPage(undefined, page),
    activity: activity ?? null,
    ...(page.latestTurn !== undefined ? { latestTurn: page.latestTurn } : {}),
    ...(page.actionablePromptIds !== undefined
      ? { actionablePromptIds: page.actionablePromptIds }
      : {}),
    ...(page.working !== undefined ? { working: page.working } : {}),
    ...(backgroundTasks !== undefined
      ? { backgroundTasks }
      : page.backgroundTasks !== undefined
        ? {
            backgroundTasks: admitAgentSessionBackgroundTaskState(page.backgroundTasks)
          }
        : {})
  }
}

export function mergeItems(
  current: AgentJournalRenderItem[],
  incoming: readonly AgentJournalRenderItem[],
  removedIds: readonly string[]
): AgentJournalRenderItem[] {
  const upserted = removedIds.length === 0 ? upsertItems(current, incoming) : null
  if (upserted) {
    return upserted
  }
  const removed = new Set(removedIds)
  const byId = new Map(
    current.filter((item) => !removed.has(item.itemId)).map((item) => [item.itemId, item])
  )
  for (const item of incoming) {
    const prior = byId.get(item.itemId)
    if (!prior || item.revision >= prior.revision) {
      byId.set(item.itemId, item)
    }
  }
  return [...byId.values()].sort(compareAgentJournalItems)
}

/** Retained rows already fit the limits, which only grow, so rows revised in place skip the rescan. */
export function mergeLiveItems(
  current: AgentJournalRenderItem[],
  incoming: readonly AgentJournalRenderItem[],
  removedIds: readonly string[]
): { items: AgentJournalRenderItem[]; rescan: boolean } {
  const inPlace = removedIds.length === 0 ? replaceItemsInPlace(current, incoming) : null
  return inPlace
    ? { items: inPlace, rescan: false }
    : { items: mergeItems(current, incoming, removedIds), rescan: true }
}

/** Revisions of loaded rows at their own positions; null when any row is new, moved or changes owner, so retention may need a fresh scan. */
function replaceItemsInPlace(
  current: AgentJournalRenderItem[],
  incoming: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem[] | null {
  let next: AgentJournalRenderItem[] | null = null
  let textOnly = true
  const at: number[] = []
  for (const item of incoming) {
    const index = rowIndexAt(current, item)
    const prior = current[index]
    if (!prior || isRootAgentJournalItem(prior) !== isRootAgentJournalItem(item)) {
      return null
    }
    if (item.revision >= prior.revision) {
      textOnly &&= onlyStreamedTextChanged(prior, item)
      next ??= current.slice()
      next[index] = item
      at.push(index)
    }
  }
  if (next) {
    noteRevisedInPlace(next, current, at)
  }
  if (next && textOnly) {
    noteStreamedTextRevision(next, current)
  }
  return next ?? current
}

/** Rows are in position order, so each lookup is a binary search. */
function rowIndexAt(rows: readonly AgentJournalRenderItem[], item: AgentJournalRenderItem): number {
  let low = 0
  let high = rows.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const order = compareAgentJournalItems(rows[middle], item)
    if (order === 0) {
      return rows[middle].itemId === item.itemId ? middle : -1
    }
    if (order < 0) {
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return -1
}

/** Streamed revisions replace their row in place and new rows append past the tail, keeping every other row's
 * position; anything that would move a row returns null for the full merge. */
function upsertItems(
  current: AgentJournalRenderItem[],
  incoming: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem[] | null {
  if (incoming.length === 0) {
    return current
  }
  // One pass copies the rows and finds every incoming id's row.
  const rowOf = new Map(incoming.map((item) => [item.itemId, -1]))
  const next: AgentJournalRenderItem[] = []
  for (const row of current) {
    if (rowOf.has(row.itemId)) {
      rowOf.set(row.itemId, next.length)
    }
    next.push(row)
  }
  let changed = false
  for (const item of incoming) {
    const index = rowOf.get(item.itemId)!
    const prior = next[index]
    if (prior && item.revision < prior.revision) {
      continue
    }
    const tail = next.at(-1)
    if (
      prior
        ? compareAgentJournalItems(prior, item) !== 0
        : tail && compareAgentJournalItems(tail, item) >= 0
    ) {
      return null
    }
    if (prior) {
      next[index] = item
    } else {
      rowOf.set(item.itemId, next.push(item) - 1)
    }
    changed = true
  }
  return changed ? next : current
}

/** Keep the contiguous loaded suffix: an older revision retains its sequence and would move the paging anchor past a hole.
 * Leave it for paging unless the window already covers the whole journal, where revival below the head cannot skip rows. */
export function liveItemsWithinWindow(
  state: StructuredAgentSessionState,
  incoming: readonly AgentJournalRenderItem[]
): readonly AgentJournalRenderItem[] {
  const head = state.items[0]
  if (!head || !state.hasOlder) {
    return incoming
  }
  return incoming.filter((item) => item.sequence >= head.sequence)
}
