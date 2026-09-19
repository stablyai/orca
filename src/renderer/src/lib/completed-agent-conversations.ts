import type { AppState } from '@/store/types'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import {
  buildActivityEvents,
  createActivityEventBuildCache
} from '@/components/activity/activity-event-builder'
import { buildAgentPaneThreads } from '@/components/activity/activity-thread-builder'
import type { AgentPaneThread } from '@/components/activity/activity-thread-types'
import { hasActivityThreadWorkspace } from '@/components/activity/activity-thread-actions'
import { projectActivityTabs } from '@/components/activity/activity-tab-projection'
import { getActivityThreadWorkspaceTitle } from './activity-thread-display'
import { selectExecutionHostDisplayLabel } from './execution-host-display-label'
import {
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../shared/execution-host'
import {
  MAX_DOCK_COMPLETED_CONVERSATIONS,
  type DockCompletedConversation
} from '../../../shared/dock-completed-conversations'

export function completedConversationId(thread: AgentPaneThread, state: AppState): string {
  return JSON.stringify([
    getWorktreeExecutionHostId(
      thread.worktree,
      thread.repo ?? undefined,
      getSettingsFocusedExecutionHostId(state.settings)
    ),
    thread.worktree.id,
    thread.paneKey,
    thread.latestEvent?.entry.providerSession?.id,
    thread.latestEvent?.timestamp
  ])
}

export function createCompletedConversationsSelector(): (state: AppState) => {
  entries: DockCompletedConversation[]
  threads: Map<string, AgentPaneThread>
} {
  const cache = createActivityEventBuildCache()
  let previousInputs: unknown[] = []
  let activityTabs: ReturnType<typeof projectActivityTabs> | null = null
  let result: { entries: DockCompletedConversation[]; threads: Map<string, AgentPaneThread> } = {
    entries: [],
    threads: new Map()
  }
  return (state) => {
    const inputs = [
      state.agentStatusByPaneKey,
      state.retainedAgentsByPaneKey,
      state.runtimeAgentOrchestrationByPaneKey,
      state.tabsByWorktree,
      state.unifiedTabsByWorktree,
      state.worktreesByRepo,
      state.detectedWorktreesByRepo,
      state.folderWorkspaces,
      state.repos,
      state.acknowledgedAgentsByPaneKey,
      state.activityClearedAtByPaneKey,
      state.settings,
      state.runtimeEnvironments,
      state.sshTargetLabels,
      state.removedSshTargetLabels
    ]
    if (inputs.every((input, index) => input === previousInputs[index])) {
      return result
    }
    previousInputs = inputs
    activityTabs = projectActivityTabs(state.unifiedTabsByWorktree, activityTabs)
    const built = buildActivityEvents(
      {
        agentStatusByPaneKey: state.agentStatusByPaneKey,
        retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
        runtimeAgentOrchestrationByPaneKey: state.runtimeAgentOrchestrationByPaneKey,
        tabsByWorktree: state.tabsByWorktree,
        unifiedTabsByWorktree: activityTabs,
        worktreeMap: getWorktreeMapFromState(state),
        repoMap: getRepoMapFromState(state),
        repos: state.repos,
        resolveWorktree: state.getKnownWorktreeById,
        acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey,
        activityClearedAtByPaneKey: state.activityClearedAtByPaneKey,
        currentOnly: true,
        now: Date.now()
      },
      cache
    )
    const catalog = {
      worktreesByRepo: state.worktreesByRepo,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      defaultHostId: getSettingsFocusedExecutionHostId(state.settings)
    }
    const threads = buildAgentPaneThreads({
      ...built,
      generatedTitlesEnabled: state.settings?.tabAutoGenerateTitle === true
    })
      .filter(
        (thread) =>
          thread.latestEvent?.state === 'done' &&
          thread.latestEvent.unread &&
          !thread.latestEvent.entry.interrupted &&
          !thread.latestEvent.entry.restoredUnconfirmed &&
          !thread.currentAgentState &&
          (!state.agentStatusByPaneKey[thread.paneKey] ||
            state.agentStatusByPaneKey[thread.paneKey].state === 'done') &&
          hasActivityThreadWorkspace(thread, catalog)
      )
      .sort((a, b) => b.latestTimestamp - a.latestTimestamp || a.paneKey.localeCompare(b.paneKey))
    const targets = new Map<string, AgentPaneThread>()
    const entries = threads.slice(0, MAX_DOCK_COMPLETED_CONVERSATIONS).map((thread) => {
      const id = completedConversationId(thread, state)
      targets.set(id, thread)
      const hostId = getWorktreeExecutionHostId(
        thread.worktree,
        thread.repo ?? undefined,
        getSettingsFocusedExecutionHostId(state.settings)
      )
      const host = hostId === 'local' ? '' : `${selectExecutionHostDisplayLabel(state, hostId)} / `
      const label =
        `${host}${getActivityThreadWorkspaceTitle(thread.worktree)} — ${thread.paneTitle}`.replace(
          /[\r\n\t]/g,
          ' '
        )
      return { id, label: Array.from(label).slice(0, 110).join('') }
    })
    const usedLabels = new Set<string>()
    const positions = new Map<string, number>()
    for (const entry of entries) {
      const baseLabel = entry.label
      let candidate = baseLabel
      let position = positions.get(baseLabel) ?? 0
      while (usedLabels.has(candidate)) {
        position += 1
        candidate = `${baseLabel} (${position})`
      }
      positions.set(baseLabel, position)
      entry.label = candidate
      usedLabels.add(candidate)
    }
    result = {
      entries:
        JSON.stringify(entries) === JSON.stringify(result.entries) ? result.entries : entries,
      threads: targets
    }
    return result
  }
}
