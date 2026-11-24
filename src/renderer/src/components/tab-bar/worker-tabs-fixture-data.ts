import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'

export const workspace = 'worker-tabs-fixture'
export const groupId = 'worker-tabs-group'
export const leafIds = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004'
]
export const titles = [
  'Release plan',
  'Check keyboard navigation',
  'Review error handling',
  'Verify remote sessions'
]
export const tabs: Tab[] = titles.map((title, index) => ({
  id: `tab-${index}`,
  entityId: `tab-${index}`,
  worktreeId: workspace,
  groupId,
  contentType: 'terminal',
  label: title,
  customLabel: null,
  color: null,
  sortOrder: index,
  createdAt: Date.now(),
  ...(index
    ? {
        workerTab: {
          origin: {
            runId: 'run',
            dispatchId: `dispatch-${index}`,
            taskId: `task-${index}`,
            taskTitle: title,
            workerLeafId: leafIds[index],
            parent: { kind: 'pane' as const, paneKey: `tab-0:${leafIds[0]}` },
            coordinator: { kind: 'pane' as const, paneKey: `tab-0:${leafIds[0]}` }
          }
        }
      }
    : {})
}))
export const terminals: TerminalTab[] = tabs.map((tab) => ({
  id: tab.id,
  worktreeId: workspace,
  ptyId: null,
  title: tab.label,
  customTitle: null,
  color: null,
  sortOrder: tab.sortOrder,
  createdAt: tab.createdAt,
  launchAgent: 'codex',
  workerTab: tab.workerTab
}))
export const seed = {
  activeWorktreeId: workspace,
  activeGroupIdByWorktree: { [workspace]: groupId },
  groupsByWorktree: {
    [workspace]: [
      {
        id: groupId,
        worktreeId: workspace,
        activeTabId: 'tab-2',
        tabOrder: tabs.map((tab) => tab.id),
        recentTabIds: ['tab-0', 'tab-2']
      }
    ]
  },
  unifiedTabsByWorktree: { [workspace]: tabs },
  tabsByWorktree: { [workspace]: terminals },
  workerTabStripChoiceByWorktree: {
    [workspace]: { 'tab-1': 'kept' as const, 'tab-3': 'hidden' as const }
  },
  workerTabPeekByGroupId: { [groupId]: 'tab-2' },
  runtimeAgentOrchestrationByPaneKey: {
    [`tab-3:${leafIds[3]}`]: {
      taskId: 'task-3',
      dispatchId: 'dispatch-3',
      dispatchStatus: 'dispatched' as const,
      attention: { categories: ['input' as const], requiresAction: true }
    }
  }
}
