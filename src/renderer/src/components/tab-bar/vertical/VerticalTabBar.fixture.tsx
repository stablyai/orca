import { useState } from 'react'
import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import TabBar from '../TabBar'

const WORKSPACE_ID = 'vertical-tabs-fixture'
const TITLES = [
  'Should we regenerate the conversation title?',
  'Native chat tab title regeneration',
  'Codex Chat',
  'Terminal 1',
  "You're the president agent coordinating this review"
]
const noop = (): void => {}

function VerticalTabsFixture({ count }: { count: number }): React.JSX.Element {
  const [activeTabId, setActiveTabId] = useState('tab-1')
  const tabs: TerminalTab[] = Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`,
    worktreeId: WORKSPACE_ID,
    ptyId: null,
    title: TITLES[index % TITLES.length],
    customTitle: null,
    color: index === 2 ? '#22c55e' : null,
    sortOrder: index,
    createdAt: 0,
    launchAgent: index % 2 === 0 ? 'codex' : undefined
  }))
  return (
    <DndContext>
      <div className="flex h-[420px] bg-card">
        <TabBar
          orientation="vertical"
          tabs={tabs}
          activeTabId={activeTabId}
          activeTabType="terminal"
          worktreeId={WORKSPACE_ID}
          groupId="vertical-tabs-group"
          expandedPaneByTabId={{}}
          showAgentLaunchItems={false}
          onActivate={setActiveTabId}
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
        <div className="flex-1 bg-background" />
      </div>
    </DndContext>
  )
}

export const expanded = defineFixture({
  width: 640,
  render: () => <VerticalTabsFixture count={6} />
})

export const collapsed = defineFixture({
  width: 640,
  store: { verticalTabListCollapsed: true },
  render: () => <VerticalTabsFixture count={6} />
})

export const overflowing = defineFixture({
  width: 640,
  render: () => <VerticalTabsFixture count={40} />
})
