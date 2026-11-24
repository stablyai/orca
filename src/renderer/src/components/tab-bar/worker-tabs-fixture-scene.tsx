import { DndContext } from '@dnd-kit/core'
import { useTabGroupWorkspaceModel } from '../tab-group/workspace-model/useTabGroupWorkspaceModel'
import TabBar from './TabBar'
import { workspace, groupId } from './worker-tabs-fixture-data'

export function WorkerTabsFixtureStrip(): React.JSX.Element {
  const model = useTabGroupWorkspaceModel({ groupId, worktreeId: workspace })
  return (
    <DndContext>
      <div className="@container/tab-strip h-8 bg-card">
        <TabBar
          tabs={model.terminalTabs}
          activeTabId={model.activeTab?.entityId ?? null}
          activeTabType="terminal"
          worktreeId={workspace}
          groupId={groupId}
          tabBarOrder={model.tabBarOrder}
          expandedPaneByTabId={{}}
          showAgentLaunchItems={false}
          onActivate={model.commands.activateTerminal}
          onClose={model.commands.closeItem}
          onCloseOthers={model.commands.closeOthers}
          onCloseToRight={model.commands.closeToRight}
          onCloseToLeft={model.commands.closeToLeft}
          onNewTerminalTab={() => {}}
          onNewBrowserTab={() => {}}
          onSetCustomTitle={() => {}}
          onSetTabColor={() => {}}
          onTogglePaneExpand={() => {}}
        />
      </div>
    </DndContext>
  )
}
