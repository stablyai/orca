import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionBackgroundTaskState,
  AgentSessionTurnActivity
} from './agent-session-wire'
import type {
  StructuredAgentHostClock,
  StructuredAgentSessionState
} from './structured-agent-session-reducer'
import { compareAgentJournalItems } from './agent-session-journal-position'
import {
  MAX_RETAINED_ITEMS,
  MAX_RETAINED_OWN_ITEMS,
  ownItemCount
} from './structured-agent-session-item-retention'
import { foldStructuredAgentSubagentRosterPage } from './structured-agent-session-subagent-roster'
import { admitAgentSessionBackgroundTaskState } from './agent-session-background-task-state-admission'
import { agentSessionHasOlderTranscript } from './agent-session-context-clear'

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
  current: readonly AgentJournalRenderItem[],
  incoming: readonly AgentJournalRenderItem[],
  removedIds: readonly string[]
): AgentJournalRenderItem[] {
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
