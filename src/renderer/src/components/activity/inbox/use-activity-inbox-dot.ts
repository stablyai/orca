import { useMemo, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { createAgentStatusEpochSelector } from '@/lib/agent-status/evidence/agent-status-epoch-selector'
import { getAgentStatusEpochNow } from '@/lib/agent-status/evidence/agent-status-epoch-clock'
import { readBots, readLiveBotHostIds, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { useAccessRequests } from '@/lib/bot-access-requests'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { selectSidebarLineageParentIdentities } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { Bot } from '../../../../../shared/bot-types'
import { isBotWorkspaceId } from './activity-inbox-bot-workspace'
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
      _rowOwnersRevision: number,
      // Null without bots. A new value (bots, nesting or host status changed) re-runs the scan.
      bots: readonly Bot[] | null,
      _botNesting: unknown
    ) =>
      hasActivityInboxAgentAttention(
        {
          agentStatusByPaneKey: state.agentStatusByPaneKey,
          migrationUnsupportedByPtyId,
          acknowledgedAgentsByPaneKey,
          activityClearedAtByPaneKey
        },
        getAgentStatusEpochNow(state.agentStatusEpoch),
        bots ? (worktreeId) => isBotWorkspaceId(state, bots, worktreeId) : null
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
  const allBots = useSyncExternalStore(subscribeToBotChanges, readBots)
  const bots = allBots.length > 0 ? allBots : null
  // Which bot a workspace belongs to reads its nesting and host status; with no bots this reads nothing.
  const botNesting = useAppStoreWithHostStatuses((s, statuses) =>
    bots ? selectSidebarLineageParentIdentities(s, statuses) : null
  )
  const botFolders = useAppStore((s) => (bots ? selectFolderWorkspaces(s) : null))
  // The bot check also looks workspaces up by id, so rows that load late must re-run the scan too.
  const botRows = useAppStore((s) => (bots ? selectWorktreesByRepo(s) : null))
  const botDetectedRows = useAppStore((s) => (bots ? selectDetectedWorktreesByRepo(s) : null))
  // One stable value per change, so the epoch selector re-runs its scan only when one of these moves.
  const botNestingKey = useMemo(
    () => (bots ? [botNesting, botFolders, botRows, botDetectedRows] : null),
    [bots, botNesting, botFolders, botRows, botDetectedRows]
  )
  const agents = useAppStore((state) =>
    selectAgentAttention(
      state,
      state.migrationUnsupportedByPtyId,
      state.acknowledgedAgentsByPaneKey,
      state.activityClearedAtByPaneKey,
      state.agentStatusByPaneKey.projection.rowOwnersRevision(),
      bots,
      botNestingKey
    )
  )
  // Never useBots(): it would start a bots.list. The snapshot notifies only when its lists change.
  const botTasks = useSyncExternalStore(subscribeToBotChanges, hasActivityInboxBotAttention)
  const requests = useAccessRequests()
  // Whether a request is live reads its host's state and the bot list, so re-check when either changes.
  const liveHosts = useSyncExternalStore(subscribeToBotChanges, readLiveBotHostIds)
  const access = useMemo(
    () => requests.some((request) => isLiveAccessRequest(request)),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- liveHosts and allBots are what isLiveAccessRequest reads.
    [requests, liveHosts, allBots]
  )
  return { agents, bots: botTasks || access }
}

/** The rail's dot: anything at all in the inbox. */
export function useActivityInboxDot(): boolean {
  const { agents, bots } = useActivityInboxAttention()
  return agents || bots
}
