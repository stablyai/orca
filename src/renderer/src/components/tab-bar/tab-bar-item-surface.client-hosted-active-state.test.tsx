// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import {
  clearClientHostedBrowserRowSelection,
  getClientHostedBrowserRowSelection,
  selectClientHostedBrowserRow
} from '@/lib/pane-manager/client-hosted-browser-row-state'
import type { TabBarItem } from './tab-bar-item-model'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import { renderTabBarItems } from './tab-bar-item-surface'

const ITEMS: TabBarItem[] = [
  {
    type: 'terminal',
    id: 'terminal-1',
    unifiedTabId: 'unified-terminal-1',
    isPinned: false,
    data: {
      id: 'terminal-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'Setup',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
  },
  {
    type: 'browser',
    id: 'browser-1',
    unifiedTabId: 'unified-browser-1',
    isPinned: false,
    data: {
      id: 'browser-1',
      worktreeId: 'wt-1',
      url: 'https://example.test/',
      title: 'Example Domain',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 0
    }
  },
  {
    type: 'editor',
    id: 'file-1',
    unifiedTabId: 'unified-file-1',
    isPinned: false,
    data: {
      id: 'file-1',
      filePath: '/repo/README.md',
      relativePath: 'README.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      isPreview: false,
      isDirty: false,
      mode: 'edit'
    }
  }
]

// Only the fields renderTabBarItems reads; nothing else reaches an isActive decision.
const RUNTIME = {
  resolvedGroupId: 'group-1',
  generatedTabTitlesEnabled: false,
  unifiedTabByVisibleId: new Map(),
  nativeChatEnabled: false,
  tabAgentTypesByTabId: {},
  nativeChatTabWideFallbackUnsafeTabsById: {},
  nativeChatTranscriptIsLocalReadable: false,
  managedBrowserCreationEnabled: false,
  toggleTabViewMode: () => {},
  statusByRelativePath: new Map()
} as unknown as TabBarRuntimeModel

function makeProps(activeTabType: WorkspaceVisibleTabType): TabBarProps {
  return {
    worktreeId: 'wt-1',
    activeTabId: 'terminal-1',
    activeFileId: 'file-1',
    activeBrowserTabId: 'browser-1',
    activeSimulatorTabId: null,
    activeTabType,
    groupActiveTabId: 'unified-terminal-1',
    expandedPaneByTabId: {}
  } as unknown as TabBarProps
}

function activeFlags(
  activeTabType: WorkspaceVisibleTabType,
  activeClientHostedBrowserRowId: string | null
): boolean[] {
  const rendered = renderTabBarItems({
    items: ITEMS,
    props: makeProps(activeTabType),
    runtime: RUNTIME,
    dropIndicatorByVisibleId: new Map(),
    includeTopTabBorder: true,
    activeClientHostedBrowserRowId,
    togglePinned: () => {}
  })
  return rendered.map(
    (node) => (node as React.ReactElement<{ isActive: boolean }>).props.isActive === true
  )
}

afterEach(() => {
  clearClientHostedBrowserRowSelection()
})

/**
 * A client-hosted row covers the pane without moving the group's `activeTabId`, so the strip's two
 * halves would each keep painting an underline — the reported double highlight.
 */
describe('real tabs while a client-hosted row is selected', () => {
  it.each<WorkspaceVisibleTabType>(['terminal', 'browser', 'editor'])(
    'underlines the %s tab the group is actually showing when no row is selected',
    (activeTabType) => {
      expect(activeFlags(activeTabType, null).filter(Boolean)).toHaveLength(1)
    }
  )

  it.each<WorkspaceVisibleTabType>(['terminal', 'browser', 'editor'])(
    'renders the %s tab inactive while a row owns the pane',
    (activeTabType) => {
      expect(activeFlags(activeTabType, 'page-1')).toEqual([false, false, false])
    }
  )
})

describe('client-hosted row while a real tab is activated', () => {
  it.each(ITEMS.map((item, index) => [item.type, index] as const))(
    'retires the row selection when the %s tab is clicked',
    (_type, index) => {
      selectClientHostedBrowserRow({
        worktreeId: 'wt-1',
        browserPageId: 'page-1',
        groupId: 'group-1',
        groupActiveTabIdAtSelection: 'unified-terminal-1'
      })
      const rendered = renderTabBarItems({
        items: ITEMS,
        props: makeProps('terminal'),
        runtime: RUNTIME,
        dropIndicatorByVisibleId: new Map(),
        includeTopTabBorder: true,
        activeClientHostedBrowserRowId: 'page-1',
        togglePinned: () => {}
      })

      const clicked = rendered[index] as React.ReactElement<{
        onActivate: (id: string) => void
      }>
      clicked.props.onActivate('terminal-1')

      expect(getClientHostedBrowserRowSelection()).toBeNull()
    }
  )
})

/**
 * The fixtures above cannot cover a row kind that does not exist yet, and a new one wired straight
 * to its own active-tab selector is exactly how this regressed the first time.
 */
describe('tab-bar active-state census', () => {
  it('suppresses every row kind while a client-hosted row owns the strip', () => {
    const source = readFileSync(join(__dirname, 'tab-bar-item-surface.tsx'), 'utf8')
    const decisions = source.match(/isActive=\{[^}]*\}/g) ?? []

    expect(decisions.length).toBeGreaterThan(0)
    for (const decision of decisions) {
      expect(decision, 'a row kind underlines itself past a client-hosted row').toContain(
        '!clientHostedRowOwnsActiveState'
      )
    }
  })
})
