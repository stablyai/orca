// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { afterEach, expect, it, vi } from 'vitest'
import type { SortableTabProps } from './SortableTab'
import type * as SortableTabModule from './SortableTab'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TabBarProps } from './tab-bar-props'
import { useTabBarItemProjection } from './use-tab-bar-item-projection'
import { useTabBarItemActions } from './use-tab-bar-item-actions'
import { renderTabBarItems } from './tab-bar-item-surface'
import { useAppStore } from '@/store'
import { TabStripTooltipProvider } from './TabStripTooltipProvider'

const renders: string[] = []
vi.mock('./SortableTab', async (importOriginal) => {
  const original = await importOriginal<typeof SortableTabModule>()
  return {
    ...original,
    default: (props: SortableTabProps) => {
      renders.push(props.tab.id)
      return original.default(props)
    }
  }
})
const NOOP = (): void => {}
const tabs: TerminalTab[] = Array.from({ length: 3 }, (_, i) => ({
  id: `term-${i}`,
  worktreeId: 'wt-1',
  ptyId: null,
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: i,
  createdAt: 0
}))

function Strip({ title = 'Terminal', activeTabId = 'term-0' }) {
  const props: TabBarProps = {
    tabs: tabs.map((tab) => (tab.id === 'term-2' ? { ...tab, title } : { ...tab })),
    worktreeId: 'wt-1',
    activeTabId,
    activeTabType: 'terminal',
    expandedPaneByTabId: {},
    onActivate: NOOP,
    onClose: NOOP,
    onCloseOthers: NOOP,
    onCloseToRight: NOOP,
    onCloseToLeft: NOOP,
    onNewTerminalTab: NOOP,
    onNewBrowserTab: NOOP,
    onSetCustomTitle: NOOP,
    onSetTabColor: NOOP,
    onTogglePaneExpand: NOOP
  }
  const runtime = {
    resolvedGroupId: 'group-1',
    unifiedTabs: [],
    unifiedTabByVisibleId: new Map(),
    generatedTabTitlesEnabled: false,
    statusByRelativePath: new Map(),
    tabAgentTypesByTabId: {},
    nativeChatTabWideFallbackUnsafeTabsById: {},
    nativeChatTranscriptIsLocalReadable: false,
    managedBrowserCreationEnabled: false
  }
  const projection = useTabBarItemProjection({ props, ...runtime })
  const actions = useTabBarItemActions({ props, togglePinned: NOOP, toggleTabViewMode: NOOP })
  return (
    <DndContext>
      <SortableContext items={projection.sortableIds}>
        <TabStripTooltipProvider>
          {renderTabBarItems({
            items: projection.orderedItems,
            props,
            runtime,
            actions,
            dropIndicatorByVisibleId: projection.dropIndicatorByVisibleId,
            includeTopTabBorder: true,
            activeClientHostedBrowserRowId: null
          })}
        </TabStripTooltipProvider>
      </SortableContext>
    </DndContext>
  )
}

const originalUnread = useAppStore.getState().unreadTerminalTabs

afterEach(() => {
  cleanup()
  renders.length = 0
  useAppStore.setState({ unreadTerminalTabs: originalUnread })
})
it('isolates title, status and active-state writes through the real sortable components', () => {
  const view = render(<Strip />)
  renders.length = 0
  view.rerender(<Strip title="Renamed" />)
  expect(renders).toEqual(['term-2'])
  expect(
    view.container.querySelector('[data-tab-id="term-2"]')?.getAttribute('data-tab-title')
  ).toBe('Renamed')
  renders.length = 0
  view.rerender(<Strip title="Renamed" activeTabId="term-1" />)
  expect(renders).toEqual(['term-0', 'term-1'])

  renders.length = 0
  act(() => useAppStore.setState({ unreadTerminalTabs: { 'term-2': true } }))
  expect(renders).toEqual(['term-2'])
})
