import { useAppStore } from '@/store'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { getWorktreeIdsWithLiveAgent, isInactiveWorkspace } from '@/lib/worktree-activity-state'
import { getWorktreeIdsWithStructuredChat } from './visible-worktree-activity-inputs'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'
import {
  hasUnknownStructuredChat,
  type StructuredChatSleptAtByPaneKey
} from '@/store/slices/structured-chat-slept-at'

type TabLike = { id: string }

// Partial store mocks may omit slices; shared predicates treat absence as empty.
type SleepStateInput = {
  agentStatusByPaneKey?: Record<string, AgentStatusEntry> | null
  agentStatusEpoch?: number
  tabsByWorktree?: Record<string, readonly TabLike[]> | null
  ptyIdsByTabId?: Record<string, string[]> | null
  browserTabsByWorktree?: Record<string, readonly TabLike[]> | null
  unifiedTabsByWorktree?: Record<string, Tab[]> | null
  structuredChatSleptAtByPaneKey?: StructuredChatSleptAtByPaneKey
}

type LiveAgentGeneration = {
  agentStatusByPaneKey: SleepStateInput['agentStatusByPaneKey']
  tabsByWorktree: SleepStateInput['tabsByWorktree']
  agentStatusNow: number
  worktreeIds: ReadonlySet<string>
}

let liveAgentGeneration: LiveAgentGeneration | null = null

// Cache the whole-store live-agent scan across cards by relevant snapshots and freshness epoch.
function selectWorktreeIdsWithLiveAgent(state: SleepStateInput): ReadonlySet<string> {
  const agentStatusNow = getAgentStatusEpochNow(state.agentStatusEpoch ?? 0)
  if (
    liveAgentGeneration &&
    liveAgentGeneration.agentStatusByPaneKey === state.agentStatusByPaneKey &&
    liveAgentGeneration.tabsByWorktree === state.tabsByWorktree &&
    liveAgentGeneration.agentStatusNow === agentStatusNow
  ) {
    return liveAgentGeneration.worktreeIds
  }
  const worktreeIds = getWorktreeIdsWithLiveAgent(
    state.agentStatusByPaneKey,
    state.tabsByWorktree,
    agentStatusNow
  )
  liveAgentGeneration = {
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    tabsByWorktree: state.tabsByWorktree,
    agentStatusNow,
    worktreeIds
  }
  return worktreeIds
}

/** Use the hide-sleeping predicate; retained done status alone cannot establish whether a workspace is asleep. */
export function selectIsSleepingWorktree(state: SleepStateInput, worktreeId: string): boolean {
  if (
    hasUnknownStructuredChat(
      state.unifiedTabsByWorktree?.[worktreeId],
      state.structuredChatSleptAtByPaneKey
    )
  ) {
    return false
  }
  return isInactiveWorkspace(
    worktreeId,
    state.tabsByWorktree,
    state.ptyIdsByTabId,
    state.browserTabsByWorktree,
    selectWorktreeIdsWithLiveAgent(state),
    getWorktreeIdsWithStructuredChat(
      state.unifiedTabsByWorktree,
      state.structuredChatSleptAtByPaneKey
    )
  )
}

export function useIsSleepingWorktree(worktreeId: string): boolean {
  return useAppStore((state) => selectIsSleepingWorktree(state, worktreeId))
}

export function resetWorktreeSleepStateCacheForTests(): void {
  liveAgentGeneration = null
}
