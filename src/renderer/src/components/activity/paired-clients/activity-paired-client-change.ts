import { useAppStore } from '@/store'
import { latestAgentTurnTimestamp } from '@/store/slices/ui/ui-slice-agent-notification-acknowledgement'
import type {
  AgentListPublication,
  AgentPaneActivityChange
} from '../../../../../shared/agent-status/presentation/agent-list-status'
import { clearActivityThread } from '../thread-list/activity-clear-completed'
import { publishAgentListNow, readPublishedAgentPaneThreads } from './agent-list-verdict-publisher'

/** Applies a paired client's change with the same actions as the Agents list row, then answers with the list it leaves. */
export function applyPairedClientActivityChange(
  change: AgentPaneActivityChange
): Promise<AgentListPublication> {
  const state = useAppStore.getState()
  const threads = readPublishedAgentPaneThreads()
  // Unhydrated maps are empty, and main would persist them over the saved ones.
  if (!state.persistedUIReady || !threads) {
    throw new Error('agent_activity_not_ready')
  }
  if (change.kind === 'read') {
    const upTo = change.upToTimestamp
    const paneKeys =
      upTo === undefined
        ? change.paneKeys
        : change.paneKeys.filter((paneKey) => {
            const thread = threads.find((candidate) => candidate.paneKey === paneKey)
            const liveEntry = state.agentStatusByPaneKey.get(paneKey)
            const latest = Math.max(
              thread?.latestTimestamp ?? 0,
              liveEntry ? latestAgentTurnTimestamp(liveEntry) : 0
            )
            return latest <= upTo
          })
    if (paneKeys.length > 0) {
      state.acknowledgeAgents(paneKeys, undefined, 'explicit')
    }
  } else if (change.kind === 'unread') {
    state.unacknowledgeAgents(change.paneKeys)
  } else {
    const paneKeys = new Set(change.paneKeys)
    let cleared = 0
    for (const thread of threads) {
      if (paneKeys.has(thread.paneKey) && clearActivityThread(thread)) {
        cleared += 1
      }
    }
    // Answering success would let the phone drop its guess and show the row again with no word why.
    if (cleared === 0) {
      throw new Error('agent_activity_not_clearable')
    }
  }
  return publishAgentListNow()
}
