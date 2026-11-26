import { useMemo, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { createAgentStatusEpochSelector } from '@/lib/agent-status/evidence/agent-status-epoch-selector'
import { getAgentStatusEpochNow } from '@/lib/agent-status/evidence/agent-status-epoch-clock'
import { readBots, readLiveBotHostIds, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { useAccessRequests } from '@/lib/bot-access-requests'
import {
  hasActivityInboxAgentAttention,
  hasActivityInboxBotAttention,
  isLiveAccessRequest
} from './activity-inbox'

// Same-turn heartbeats keep the epoch, so they never rerun the scan; turn and freshness changes bump it.
const createAgentAttentionSelector = () =>
  createAgentStatusEpochSelector(
    (
      state: AppState,
      migrationUnsupportedByPtyId: AppState['migrationUnsupportedByPtyId'],
      acknowledgedAgentsByPaneKey: AppState['acknowledgedAgentsByPaneKey'],
      activityClearedAtByPaneKey: AppState['activityClearedAtByPaneKey'],
      // Closing a tab can drop a pane's row without a status write.
      _rowOwnersRevision: number
    ) =>
      hasActivityInboxAgentAttention(
        {
          agentStatusByPaneKey: state.agentStatusByPaneKey,
          migrationUnsupportedByPtyId,
          acknowledgedAgentsByPaneKey,
          activityClearedAtByPaneKey
        },
        getAgentStatusEpochNow(state.agentStatusEpoch)
      )
  )

export type ActivityInboxAttention = {
  /** An agent waits on you, or has an outcome you haven't read. */
  agents: boolean
  /** A bot has tasks needing you, or someone asked for access: the rows above the agent list. */
  bots: boolean
}

/** What the Activity inbox has for you. Reads only what the renderer already holds; never fetches. */
export function useActivityInboxAttention(): ActivityInboxAttention {
  const [selectAgentAttention] = useState(createAgentAttentionSelector)
  const agents = useAppStore((state) =>
    selectAgentAttention(
      state,
      state.migrationUnsupportedByPtyId,
      state.acknowledgedAgentsByPaneKey,
      state.activityClearedAtByPaneKey,
      state.agentStatusByPaneKey.projection.rowOwnersRevision()
    )
  )
  // Never useBots(): it would start a bots.list. The snapshot notifies only when its lists change.
  const botTasks = useSyncExternalStore(subscribeToBotChanges, hasActivityInboxBotAttention)
  const requests = useAccessRequests()
  // Whether a request is live reads its host's state and the bot list, so re-check when either changes.
  const liveHosts = useSyncExternalStore(subscribeToBotChanges, readLiveBotHostIds)
  const bots = useSyncExternalStore(subscribeToBotChanges, readBots)
  const access = useMemo(
    () => requests.some((request) => isLiveAccessRequest(request)),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- liveHosts and bots are what isLiveAccessRequest reads.
    [requests, liveHosts, bots]
  )
  return { agents, bots: botTasks || access }
}

/** The rail's dot: anything at all in the inbox. */
export function useActivityInboxDot(): boolean {
  const { agents, bots } = useActivityInboxAttention()
  return agents || bots
}
