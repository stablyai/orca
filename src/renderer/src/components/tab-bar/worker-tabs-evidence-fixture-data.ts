import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AppState } from '@/store/types'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { workspace, seed, tabs, leafIds, singleLeafLayouts } from './worker-tabs-fixture-data'

function extraWorker(index: number, title: string): Tab {
  const template = tabs[1]!
  if (!template.workerTab) {
    throw new Error('Worker fixture stamp missing')
  }
  return {
    ...template,
    id: `tab-${index}`,
    entityId: `tab-${index}`,
    label: title,
    sortOrder: index,
    workerTab: {
      origin: {
        ...template.workerTab.origin,
        taskId: `task-${index}`,
        dispatchId: `dispatch-${index}`,
        taskTitle: title,
        workerLeafId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      }
    }
  }
}
export const allTabs = [
  ...tabs,
  extraWorker(4, 'Finish release notes'),
  extraWorker(5, 'Stop legacy migration')
].map((tab, index) => {
  if (!tab.workerTab || (index !== 2 && index !== 3)) {
    return tab
  }
  return {
    ...tab,
    workerTab: {
      origin: {
        ...tab.workerTab.origin,
        parent:
          index === 2
            ? { kind: 'pane' as const, paneKey: `tab-1:${leafIds[1]}` }
            : {
                kind: 'pane' as const,
                paneKey: 'closed-helper:00000000-0000-4000-8000-000000000099'
              }
      }
    }
  }
})
const now = Date.now()
export const contexts = Object.fromEntries(
  allTabs
    .filter((t) => t.workerTab)
    .map((tab) => {
      const origin = tab.workerTab!.origin,
        index = tab.sortOrder
      return [
        `${tab.id}:${origin.workerLeafId}`,
        {
          taskId: origin.taskId,
          dispatchId: origin.dispatchId,
          dispatchStatus:
            index === 3 || index === 5
              ? ('failed' as const)
              : index === 4
                ? ('completed' as const)
                : ('dispatched' as const),
          ...(index === 5 ? { stopped: true as const } : {}),
          attention: {
            categories: index === 2 ? ['input' as const] : [],
            requiresAction: index === 2
          }
        }
      ]
    })
)
export const state: Partial<AppState> = {
  ...seed,
  terminalLayoutsByTabId: singleLeafLayouts(allTabs),
  unifiedTabsByWorktree: { [workspace]: allTabs },
  tabsByWorktree: {
    [workspace]: allTabs.map((tab) => ({
      id: tab.id,
      worktreeId: workspace,
      ptyId: `fixture-${tab.id}`,
      title: tab.label,
      customTitle: null,
      color: null,
      sortOrder: tab.sortOrder,
      createdAt: now,
      launchAgent: 'codex',
      workerTab: tab.workerTab
    }))
  },
  groupsByWorktree: {
    [workspace]: [{ ...seed.groupsByWorktree[workspace][0]!, tabOrder: allTabs.map((t) => t.id) }]
  },
  workerTabStripChoiceByWorktree: {
    [workspace]: { 'tab-1': 'kept', 'tab-3': 'hidden', 'tab-4': 'hidden', 'tab-5': 'hidden' }
  },
  runtimeAgentOrchestrationByPaneKey: contexts,
  agentStatusByPaneKey: acceptedAgentStatuses(
    allTabs
      .filter((t) => t.workerTab)
      .map((tab) => [
        `${tab.id}:${tab.workerTab!.origin.workerLeafId}`,
        {
          paneKey: `${tab.id}:${tab.workerTab!.origin.workerLeafId}`,
          worktreeId: workspace,
          tabId: tab.id,
          agentType: 'codex',
          state: 'working' as const,
          prompt: tab.label,
          updatedAt: now,
          stateStartedAt: now,
          stateHistory: []
        }
      ])
  )
}
