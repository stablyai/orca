import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { Tab } from '../../../../../shared/tab-types'
import TabBar from '../../tab-bar/TabBar'
import { TabBarOrderControl } from './TabBarOrderControl'

const WT = 'folder-workspace'
const noop = (): void => {}
const labels = ['Pinned reference', 'Terminal A', 'Terminal B', 'Terminal C']
const tabs: Tab[] = labels.map((label, index) => ({
  id: `tab-${index}`,
  entityId: `tab-${index}`,
  groupId: 'group',
  worktreeId: WT,
  contentType: 'terminal',
  label,
  customLabel: null,
  color: null,
  sortOrder: index,
  createdAt: 0,
  isPinned: index === 0
}))

function Example(): React.JSX.Element {
  const mode = useAppStore((state) => state.settings?.tabBarOrderMode ?? 'manual')
  const order = useAppStore((state) => state.groupsByWorktree[WT][0].tabOrder)
  return (
    <div className="settings-view-shell space-y-6 bg-background p-8 text-foreground">
      <TabBarOrderControl
        value={mode}
        updateSettings={(updates) =>
          useAppStore.setState((state) => ({ settings: { ...state.settings!, ...updates } }))
        }
      />
      <DndContext>
        <div className="@container/tab-strip h-8 bg-card">
          <TabBar
            worktreeId={WT}
            groupId="group"
            groupActiveTabId="tab-3"
            tabs={tabs.map((tab) => ({
              id: tab.id,
              worktreeId: WT,
              ptyId: null,
              title: tab.label,
              customTitle: null,
              color: null,
              sortOrder: tab.sortOrder,
              createdAt: 0
            }))}
            tabBarOrder={order}
            activeTabId="tab-3"
            activeTabType="terminal"
            expandedPaneByTabId={{}}
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
            showAgentLaunchItems={false}
          />
        </div>
      </DndContext>
    </div>
  )
}
const store = {
  settings: {
    ...getDefaultSettings('/home/fixture'),
    uiLanguage: 'en' as const,
    tabBarOrderMode: 'manual' as const
  },
  unifiedTabsByWorktree: { [WT]: tabs },
  groupsByWorktree: {
    [WT]: [
      { id: 'group', worktreeId: WT, activeTabId: 'tab-3', tabOrder: tabs.map((tab) => tab.id) }
    ]
  },
  activeGroupIdByWorktree: { [WT]: 'group' }
}
export const manual = defineFixture({ width: 960, store, render: () => <Example /> })
export const recent = defineFixture({
  width: 960,
  store: { ...store, settings: { ...store.settings, tabBarOrderMode: 'mru' } },
  setup: () => {
    useAppStore.getState().recordTerminalInput('tab-3:00000000-0000-4000-8000-000000000001')
  },
  render: () => <Example />
})
export const options = defineFixture({
  ...manual,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[role="combobox"]')?.click()
  }
})
