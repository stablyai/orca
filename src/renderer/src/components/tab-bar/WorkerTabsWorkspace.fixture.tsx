import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import WorktreeCard from '../sidebar/workspace-card/surface/WorktreeCard'
import { FIXTURE_REPO, makeWorktree } from '../sidebar/worktree-card-slot-fixture-seeds'
import { WorkerTabsFixtureStrip } from './worker-tabs-fixture-scene'
import { groupId, workspace, seed, tabs, terminals, leafIds } from './worker-tabs-fixture-data'
import { recordWorkerTabFeed } from './worker-tab-feed-grace'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'

const child = makeWorktree({ id: workspace, name: 'Review remote startup', agents: [] }, Date.now())
const onlyWorker = tabs[3]!
function WorkspaceScene(): React.JSX.Element {
  const active = useAppStore((s) => s.activeWorktreeId === workspace)
  return (
    <div className="flex h-48 bg-background">
      <div className="w-64 shrink-0 border-r border-border">
        <WorktreeCard
          worktree={child}
          repo={FIXTURE_REPO}
          isActive={active}
          nativeDragEnabled={false}
        />
      </div>
      <div className="min-w-0 flex-1">{active ? <WorkerTabsFixtureStrip /> : null}</div>
    </div>
  )
}
const childStore = {
  ...seed,
  activeWorktreeId: null,
  repos: [FIXTURE_REPO],
  worktreesByRepo: { [FIXTURE_REPO.id]: [child] },
  unifiedTabsByWorktree: { [workspace]: [onlyWorker] },
  tabsByWorktree: { [workspace]: [terminals[3]!] },
  groupsByWorktree: {
    [workspace]: [
      {
        id: groupId,
        worktreeId: workspace,
        activeTabId: null,
        tabOrder: [onlyWorker.id],
        recentTabIds: []
      }
    ]
  },
  workerTabStripChoiceByWorktree: {},
  workerTabPeekByGroupId: {}
}
export const childBefore = defineFixture({
  width: 1000,
  store: childStore,
  render: () => (
    <ConfirmationDialogProvider>
      <WorkspaceScene />
    </ConfirmationDialogProvider>
  )
})
export const childOpened = defineFixture({
  width: 1000,
  store: childStore,
  render: () => (
    <ConfirmationDialogProvider>
      <WorkspaceScene />
    </ConfirmationDialogProvider>
  ),
  interact: (frame) => {
    const card = frame.querySelector<HTMLElement>('[data-worktree-card-surface]')
    if (!card) {
      throw new Error('Worker child card missing')
    }
    card.click()
  }
})
const restoredTabs = [tabs[0]!, tabs[3]!].map((tab) => ({ ...tab, createdAt: Date.now() - 60_000 }))
export const delayedRows = defineFixture({
  width: 800,
  store: {
    ...seed,
    unifiedTabsByWorktree: { [workspace]: restoredTabs },
    tabsByWorktree: { [workspace]: [terminals[0]!, terminals[3]!] },
    groupsByWorktree: {
      [workspace]: [
        {
          id: groupId,
          worktreeId: workspace,
          activeTabId: 'tab-0',
          tabOrder: ['tab-0', 'tab-3'],
          recentTabIds: ['tab-0']
        }
      ]
    },
    workerTabStripChoiceByWorktree: {},
    workerTabPeekByGroupId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    agentStatusByPaneKey: acceptedAgentStatuses()
  },
  setup: () => recordWorkerTabFeed('local', 'reconnect'),
  render: () => (
    <ConfirmationDialogProvider>
      <WorkerTabsFixtureStrip />
    </ConfirmationDialogProvider>
  ),
  interact: async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    useAppStore.setState({
      agentStatusByPaneKey: acceptedAgentStatuses([
        [
          `tab-3:${leafIds[3]}`,
          {
            paneKey: `tab-3:${leafIds[3]}`,
            worktreeId: workspace,
            tabId: 'tab-3',
            agentType: 'codex',
            state: 'working',
            prompt: 'Verify remote sessions',
            updatedAt: Date.now(),
            stateStartedAt: Date.now(),
            stateHistory: []
          }
        ]
      ]),
      runtimeAgentOrchestrationByPaneKey: seed.runtimeAgentOrchestrationByPaneKey
    })
    recordWorkerTabFeed('local', 'snapshot')
  }
})
