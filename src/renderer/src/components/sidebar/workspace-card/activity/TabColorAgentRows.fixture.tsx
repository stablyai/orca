import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import TabBar from '../../../tab-bar/TabBar'
import WorktreeCardAgents from './WorktreeCardAgents'
import { applyAgentRowLineage } from '../../../dashboard/agent-row-lineage'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'

const now = 1_792_983_600_000
const WORKSPACE_ID = 'tab-color-workspace'
const noop = (): void => {}
const tabs: TerminalTab[] = [
  { id: 'tab-red', title: 'Review the release notes', color: '#ef4444' },
  { id: 'tab-blue', title: 'Fix the flaky upload test', color: '#3b82f6' },
  { id: 'tab-plain', title: 'Draft the migration plan', color: null }
].map((tab, index) => ({
  ...tab,
  worktreeId: WORKSPACE_ID,
  ptyId: null,
  customTitle: null,
  sortOrder: index,
  createdAt: now - index,
  launchAgent: 'claude'
}))
const entries: AgentStatusEntry[] = tabs.map((tab, index) => ({
  paneKey: makePaneKey(tab.id, `0000000${index}-0000-4000-8000-000000000000`),
  worktreeId: WORKSPACE_ID,
  agentType: 'claude',
  state: index === 1 ? 'done' : 'working',
  prompt: tab.title,
  updatedAt: now,
  stateStartedAt: now,
  stateHistory: []
}))
const rows = applyAgentRowLineage(buildWorktreeAgentRows({ tabs, entries, retained: [], now }))

function TabColorAgentRows(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <DndContext>
        <div className="@container/tab-strip h-8 bg-card">
          <TabBar
            tabs={tabs}
            activeTabId="tab-red"
            activeTabType="terminal"
            worktreeId={WORKSPACE_ID}
            groupId="tab-color-group"
            expandedPaneByTabId={{}}
            showAgentLaunchItems={false}
            onActivate={noop}
            onClose={noop}
            onCloseOthers={noop}
            onCloseToRight={noop}
            onCloseToLeft={noop}
            onNewTerminalTab={noop}
            onNewBrowserTab={noop}
            onSetCustomTitle={noop}
            onSetTabColor={noop}
            onTogglePaneExpand={noop}
          />
        </div>
      </DndContext>
      <div className="w-[320px] bg-sidebar p-2 text-sidebar-foreground">
        <WorktreeCardAgents worktreeId={WORKSPACE_ID} agents={rows} />
      </div>
    </div>
  )
}

export const compact = defineFixture({
  width: 900,
  store: { agentActivityDisplayMode: 'compact' },
  render: () => <TabColorAgentRows />,
  interact: async (frame) => {
    frame.querySelector<HTMLElement>('.compact-agent-summary-panel [aria-expanded]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})

export const full = defineFixture({
  width: 900,
  store: { agentActivityDisplayMode: 'full' },
  render: () => <TabColorAgentRows />
})
