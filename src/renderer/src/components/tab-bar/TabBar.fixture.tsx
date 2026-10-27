import { useEffect, useState } from 'react'
import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'
import TabBar from './TabBar'
import type { TabBarProps } from './tab-bar-props'

const WORKSPACE_ID = 'tab-width-fixture'
const TITLES = [
  'Should we regenerate the conversation title?',
  'Native chat tab title regeneration',
  'Codex Chat',
  "You're the president agent coordinating this review"
]
const noop = (): void => {}
const enableFitTitles = (): void => {
  useAppStore.setState((state) => ({
    settings: state.settings && { ...state.settings, experimentalFitTabsToTitles: true }
  }))
}

function TabWidthFixture({
  count,
  titles = TITLES,
  renamedTitles,
  browserTabs,
  editorFiles,
  tabBarOrder
}: {
  count: number
  titles?: string[]
  /** Titles an agent applies after mount; widths should hold until the strip changes. */
  renamedTitles?: string[]
} & Pick<TabBarProps, 'browserTabs' | 'editorFiles' | 'tabBarOrder'>): React.JSX.Element {
  const [activeTabId, setActiveTabId] = useState('tab-0')
  const [liveTitles, setLiveTitles] = useState(titles)
  useEffect(() => {
    if (renamedTitles) {
      setLiveTitles(renamedTitles)
    }
  }, [renamedTitles])
  const tabs: TerminalTab[] = Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`,
    worktreeId: WORKSPACE_ID,
    ptyId: null,
    title: liveTitles[index % liveTitles.length],
    customTitle: null,
    color: null,
    sortOrder: index,
    createdAt: 0,
    launchAgent: 'codex'
  }))

  return (
    <DndContext>
      <div className="@container/tab-strip h-8 bg-card">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          activeTabType="terminal"
          worktreeId={WORKSPACE_ID}
          groupId="tab-width-group"
          browserTabs={browserTabs}
          editorFiles={editorFiles}
          tabBarOrder={tabBarOrder}
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
      </div>
    </DndContext>
  )
}

export const fixedWidth = defineFixture({
  width: 1280,
  render: () => <TabWidthFixture count={4} />
})

export const spacious = defineFixture({
  setup: enableFitTitles,
  width: 1280,
  render: () => <TabWidthFixture count={4} />
})

export const single = defineFixture({
  setup: enableFitTitles,
  width: 1280,
  render: () => <TabWidthFixture count={1} titles={['Terminal 1']} />
})

export const long = defineFixture({
  setup: enableFitTitles,
  width: 1280,
  render: () => <TabWidthFixture count={1} titles={['A very long conversation title '.repeat(8)]} />
})

export const contentFit = defineFixture({
  setup: enableFitTitles,
  width: 1280,
  render: () => (
    <TabWidthFixture
      count={3}
      titles={[
        'Measure the effect of the new tab layout on conversation navigation',
        'PR implementation approach',
        'Review the implementation for layout and interaction regressions'
      ]}
    />
  )
})

export const narrow = defineFixture({
  setup: enableFitTitles,
  width: 420,
  render: () => <TabWidthFixture count={4} />
})

export const mixed = defineFixture({
  setup: enableFitTitles,
  width: 620,
  render: () => (
    <TabWidthFixture
      count={3}
      titles={['A very long conversation title '.repeat(8), 'Go', 'Notes']}
    />
  )
})

export const overflowing = defineFixture({
  setup: enableFitTitles,
  width: 420,
  render: () => <TabWidthFixture count={12} />
})

export const mixedTypes = defineFixture({
  setup: enableFitTitles,
  width: 620,
  render: () => (
    <TabWidthFixture
      count={1}
      titles={['A very long conversation title '.repeat(12)]}
      tabBarOrder={['tab-0', 'browser-0', 'file-0']}
      browserTabs={[
        {
          id: 'browser-0',
          worktreeId: WORKSPACE_ID,
          url: 'https://google.com',
          title: 'Google',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 0
        }
      ]}
      editorFiles={[
        {
          id: 'file-0',
          worktreeId: WORKSPACE_ID,
          filePath: '/tmp/untitled.md',
          relativePath: 'untitled.md',
          language: 'markdown',
          isDirty: true,
          mode: 'edit'
        }
      ]}
    />
  )
})

export const competingTitles = defineFixture({
  setup: enableFitTitles,
  width: 620,
  render: () => (
    <TabWidthFixture
      count={3}
      titles={[
        'A very long conversation title '.repeat(12),
        'Go',
        'Another long conversation title '.repeat(3)
      ]}
    />
  )
})

export const agentRename = defineFixture({
  setup: enableFitTitles,
  width: 1280,
  render: () => (
    <TabWidthFixture
      count={3}
      titles={['claude', 'Review the implementation for layout regressions', 'Notes']}
      renamedTitles={['Investigate why tab widths shift after agent renames', 'Done', 'Notes']}
    />
  ),
  interact: () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
})

export const agentRenameCrowded = defineFixture({
  setup: enableFitTitles,
  width: 420,
  render: () => (
    <TabWidthFixture
      count={4}
      titles={['A very long conversation title '.repeat(4), 'Notes', 'Codex Chat', 'Review']}
      renamedTitles={['Done', 'Notes', 'Investigate why tab widths shift', 'Review']}
    />
  ),
  interact: () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
})
