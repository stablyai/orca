import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { buildActivityEvents } from './activity-event-builder'
import { projectActivityTabs } from './activity-tab-projection'
import { buildAgentPaneThreads } from './activity-thread-builder'
import { collectChildAgentPaneKeys } from './activity-thread-child-agent'
import {
  activateActivityThreadTarget,
  hasActivityThreadTerminalPane,
  hasActivityThreadWorkspace
} from './activity-thread-actions'
import { activityThreadStatusId } from './activity-thread-presentation'
import type { AgentPaneThread } from './activity-thread-types'

export type UnreadAgentJumpDirection = 'next' | 'previous'

type UnreadRank = { tier: number; since: number }

type UnreadAgentJumpSource = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
  | 'repos'
  | 'getKnownWorktreeById'
  | 'acknowledgedAgentsByPaneKey'
  | 'activityClearedAtByPaneKey'
  | 'agentsShowChildAgents'
>

function unreadRank(thread: AgentPaneThread, acknowledgedAt: number): UnreadRank | null {
  // Why the Activity classifier (not currentAgentState alone): a question left unanswered past
  // the freshness window, or restored after a restart, has no live state but still needs input.
  const status = activityThreadStatusId(thread)
  if (status === 'blocked' || status === 'waiting') {
    const entry = thread.currentAgentEntry ?? thread.paneEntry
    return thread.unread
      ? { tier: 0, since: entry?.stateStartedAt ?? thread.latestEvent?.timestamp ?? 0 }
      : null
  }
  // Why: a main agent that finished while a background shell keeps the pane `working`
  // never emits a done event, so its own turn end is the unread signal.
  if (status === 'monitoring') {
    const mainAgent = thread.currentAgentEntry?.mainAgent
    return mainAgent?.state === 'done' && acknowledgedAt < mainAgent.stateStartedAt
      ? { tier: 1, since: mainAgent.stateStartedAt }
      : null
  }
  // Why skip working: the agent is busy, so there is nothing to read or answer yet.
  if (status === 'working' || !thread.unread) {
    return null
  }
  return { tier: 1, since: thread.latestEvent?.timestamp ?? 0 }
}

function ranksBefore(a: UnreadRank, b: UnreadRank, direction: UnreadAgentJumpDirection): boolean {
  if (a.tier !== b.tier) {
    return a.tier < b.tier
  }
  // Why: 0 means the entry time is unknown; those go last in either direction.
  if (!a.since || !b.since) {
    return Boolean(a.since) && !b.since
  }
  return direction === 'next' ? a.since < b.since : a.since > b.since
}

/** Needs-input first, then unread finished turns; `next` takes the longest wait, `previous` the
 *  newest. Threads `canOpen` rejects are dropped so a stale row cannot trap every press. */
export function orderUnreadAgentJumpTargets(
  threads: readonly AgentPaneThread[],
  acknowledgedAgentsByPaneKey: Record<string, number>,
  direction: UnreadAgentJumpDirection,
  canOpen: (thread: AgentPaneThread) => boolean
): AgentPaneThread[] {
  return threads
    .flatMap((thread) => {
      const rank = unreadRank(thread, acknowledgedAgentsByPaneKey[thread.paneKey] ?? 0)
      return rank && canOpen(thread) ? [{ thread, rank }] : []
    })
    .sort((a, b) =>
      ranksBefore(a.rank, b.rank, direction) ? -1 : ranksBefore(b.rank, a.rank, direction) ? 1 : 0
    )
    .map(({ thread }) => thread)
}

// Why the child filter follows agentsShowChildAgents: the sidebar Agents list and its
// Mark all read use the same rule. Busy (`working`) turns are left for the user to see finish.
export function buildUnreadAgentJumpThreads(
  state: UnreadAgentJumpSource,
  now: number = Date.now()
): AgentPaneThread[] {
  const { events, liveAgentByPaneKey, paneEntryByPaneKey } = buildActivityEvents({
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    runtimeAgentOrchestrationByPaneKey: state.runtimeAgentOrchestrationByPaneKey,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    tabsByWorktree: state.tabsByWorktree,
    unifiedTabsByWorktree: projectActivityTabs(state.unifiedTabsByWorktree, null),
    worktreeMap: getWorktreeMapFromState(state),
    repoMap: getRepoMapFromState(state),
    repos: state.repos,
    resolveWorktree: state.getKnownWorktreeById,
    acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey,
    activityClearedAtByPaneKey: state.activityClearedAtByPaneKey,
    now
  })
  const threads = buildAgentPaneThreads({ events, liveAgentByPaneKey, paneEntryByPaneKey })
  if (state.agentsShowChildAgents) {
    return threads
  }
  const childPaneKeys = collectChildAgentPaneKeys(threads)
  return threads.filter((thread) => !childPaneKeys.has(thread.paneKey))
}

/** Unread agents in jump order; empty when there is nothing to jump to. */
export function resolveUnreadAgentJumpTargets(
  direction: UnreadAgentJumpDirection
): AgentPaneThread[] {
  const state = useAppStore.getState()
  return orderUnreadAgentJumpTargets(
    buildUnreadAgentJumpThreads(state),
    state.acknowledgedAgentsByPaneKey,
    direction,
    (thread) => {
      const isFloating = thread.worktree.id === FLOATING_TERMINAL_WORKTREE_ID
      if (!isFloating && !hasActivityThreadWorkspace(thread)) {
        return false
      }
      const hasTerminalTab = state.tabsByWorktree[thread.worktree.id]?.some(
        (tab) => tab.id === thread.tab.id
      )
      // Cold workspace tabs may revive on activation; floating tabs cannot.
      return isFloating || hasTerminalTab ? hasActivityThreadTerminalPane(thread, state) : true
    }
  )
}

/** Opens the first target that reaches its pane and marks only that agent read. */
export function jumpToFirstReachableUnreadAgent(targets: readonly AgentPaneThread[]): void {
  for (const thread of targets) {
    const wasActiveWorkspace = useAppStore.getState().activeWorktreeId === thread.worktree.id
    const activation = activateActivityThreadTarget(thread, true)
    if (activation === 'pane') {
      // Terminal focus settles next frame; its existing success handler owns acknowledgement.
      return
    }
    // Only a newly activated workspace can revive a cold-parked SSH tab on the next press.
    if (
      activation === 'workspace' &&
      thread.worktree.id !== FLOATING_TERMINAL_WORKTREE_ID &&
      !wasActiveWorkspace
    ) {
      return
    }
  }
}
