// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TabBarProps } from './tab-bar-props'
import { useTabBarItemProjection } from './use-tab-bar-item-projection'

const NOOP = (): void => {}

function terminalTab(id: string, sortOrder: number): TerminalTab & { unifiedTabId?: string } {
  return {
    id,
    unifiedTabId: `unified-${id}`,
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'zsh',
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: 0
  }
}

/** Rebuilt per call, like the store's tab list: equal content, never the same objects. */
function buildProps(ids: string[]): TabBarProps {
  return {
    tabs: ids.map((id, index) => terminalTab(id, index)),
    tabBarOrder: [...ids],
    activeTabId: ids[0] ?? null,
    activeTabType: 'terminal',
    worktreeId: 'wt-1',
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
}

function renderProjection(initialIds: string[]): {
  sortableIds: () => string[]
  rerenderWith: (ids: string[]) => void
} {
  const { result, rerender } = renderHook(
    (ids: string[]) =>
      useTabBarItemProjection({
        props: buildProps(ids),
        resolvedGroupId: 'group-1',
        unifiedTabs: [],
        unifiedTabByVisibleId: new Map(),
        generatedTabTitlesEnabled: false,
        statusByRelativePath: new Map()
      }),
    { initialProps: initialIds }
  )
  return {
    sortableIds: () => result.current.sortableIds,
    rerenderWith: (ids) => rerender(ids)
  }
}

describe('tab strip sortable ids', () => {
  it('hands dnd-kit the same array while the ids are unchanged', () => {
    const projection = renderProjection(['term-1', 'term-2'])
    const first = projection.sortableIds()

    projection.rerenderWith(['term-1', 'term-2'])

    // A new array here re-renders every tab through dnd-kit's context, even with identical ids.
    expect(projection.sortableIds()).toBe(first)
  })

  it('hands dnd-kit a new array when a tab is added', () => {
    const projection = renderProjection(['term-1', 'term-2'])

    projection.rerenderWith(['term-1', 'term-2', 'term-3'])

    expect(projection.sortableIds()).toEqual(['term-1', 'term-2', 'term-3'])
  })

  it('hands dnd-kit a new array when the tabs are reordered', () => {
    const projection = renderProjection(['term-1', 'term-2'])

    projection.rerenderWith(['term-2', 'term-1'])

    expect(projection.sortableIds()).toEqual(['term-2', 'term-1'])
  })
})
