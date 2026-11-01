import { useState } from 'react'
import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
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
function TabWidthFixture({
  count,
  titles = TITLES,
  browserTabs,
  clientHostedBrowserRows,
  editorFiles,
  tabBarOrder
}: {
  count: number
  titles?: string[]
} & Pick<
  TabBarProps,
  'browserTabs' | 'clientHostedBrowserRows' | 'editorFiles' | 'tabBarOrder'
>): React.JSX.Element {
  const [activeTabId, setActiveTabId] = useState('tab-0')
  const tabs: TerminalTab[] = Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`,
    worktreeId: WORKSPACE_ID,
    ptyId: null,
    title: titles[index % titles.length],
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
          clientHostedBrowserRows={clientHostedBrowserRows}
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

export const availableWidth = defineFixture({
  width: 1280,
  render: () => <TabWidthFixture count={4} />
})

export const twoTabs = defineFixture({
  width: 1280,
  render: () => (
    <TabWidthFixture count={2} titles={['Council Branch Review: Zero Regressions', 'Terminal 1']} />
  )
})

export const single = defineFixture({
  width: 1280,
  render: () => <TabWidthFixture count={1} titles={['Terminal 1']} />
})

export const long = defineFixture({
  width: 1280,
  render: () => <TabWidthFixture count={1} titles={['A very long conversation title '.repeat(8)]} />
})

export const narrow = defineFixture({
  width: 420,
  render: () => <TabWidthFixture count={4} />
})

export const overflowing = defineFixture({
  width: 420,
  render: () => <TabWidthFixture count={12} />
})

export const mixedTypes = defineFixture({
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

export const singleBrowser = defineFixture({
  width: 1000,
  render: () => (
    <TabWidthFixture
      count={0}
      browserTabs={[
        {
          id: 'browser-0',
          worktreeId: WORKSPACE_ID,
          url: 'https://example.com',
          title: 'A browser page with a long descriptive title',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 0
        }
      ]}
    />
  )
})

export const singleFile = defineFixture({
  width: 1000,
  render: () => (
    <TabWidthFixture
      count={0}
      editorFiles={[
        {
          id: 'file-0',
          worktreeId: WORKSPACE_ID,
          filePath: '/tmp/notes.md',
          relativePath: 'notes.md',
          language: 'markdown',
          isDirty: true,
          mode: 'edit'
        }
      ]}
    />
  )
})

export const singleHostedPage = defineFixture({
  width: 1000,
  render: () => (
    <TabWidthFixture
      count={0}
      clientHostedBrowserRows={[
        {
          browserPageId: 'hosted-0',
          worktreeId: WORKSPACE_ID,
          url: 'https://example.com',
          title: 'A page hosted on a paired device',
          loading: false,
          browserHostClientId: 'client-0',
          hostDeviceName: 'Phone',
          hostAbsent: false
        }
      ]}
    />
  )
})
