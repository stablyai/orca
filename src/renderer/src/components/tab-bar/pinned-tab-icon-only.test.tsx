// @vitest-environment happy-dom

import type React from 'react'
import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { buildTabStripLayoutKey, type TabBarItem } from './tab-bar-item-model'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import { renderTabBarItems } from './tab-bar-item-surface'

function unifiedTab(
  id: string,
  contentType: Tab['contentType'],
  label: string,
  sortOrder: number
): Tab {
  return {
    id,
    entityId: id,
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType,
    label,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 0,
    isPinned: true
  }
}

const ITEMS: TabBarItem[] = [
  {
    type: 'terminal',
    id: 'terminal-1',
    unifiedTabId: 'unified-terminal-1',
    isPinned: true,
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
    isPinned: true,
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
    isPinned: true,
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
  },
  {
    type: 'simulator',
    id: 'sim-1',
    unifiedTabId: 'unified-sim-1',
    isPinned: true,
    data: unifiedTab('sim-1', 'simulator', 'iPhone 16 Pro', 3)
  },
  {
    type: 'agent-session',
    id: 'agent-1',
    unifiedTabId: 'unified-agent-1',
    isPinned: true,
    data: { ...unifiedTab('agent-1', 'agent-session', 'Claude', 4), contentType: 'agent-session' }
  }
]

function makeRuntime(pinnedTabsIconOnly: boolean): TabBarRuntimeModel {
  return {
    resolvedGroupId: 'group-1',
    generatedTabTitlesEnabled: false,
    pinnedTabsIconOnly,
    unifiedTabByVisibleId: new Map(),
    nativeChatEnabled: false,
    tabAgentTypesByTabId: {},
    nativeChatTabWideFallbackUnsafeTabsById: {},
    nativeChatTranscriptIsLocalReadable: false,
    managedBrowserCreationEnabled: false,
    toggleTabViewMode: () => {},
    statusByRelativePath: new Map()
  } as unknown as TabBarRuntimeModel
}

const PROPS = {
  worktreeId: 'wt-1',
  activeTabId: 'terminal-1',
  activeFileId: 'file-1',
  activeBrowserTabId: 'browser-1',
  activeSimulatorTabId: null,
  activeTabType: 'terminal',
  groupActiveTabId: 'unified-terminal-1',
  expandedPaneByTabId: {}
} as unknown as TabBarProps

function iconOnlyFlags(pinnedTabsIconOnly: boolean): unknown[] {
  return renderTabBarItems({
    items: ITEMS,
    props: PROPS,
    runtime: makeRuntime(pinnedTabsIconOnly),
    dropIndicatorByVisibleId: new Map(),
    includeTopTabBorder: true,
    activeClientHostedBrowserRowId: null,
    togglePinned: () => {}
  }).map((node) => (node as React.ReactElement<{ pinnedIconOnly: boolean }>).props.pinnedIconOnly)
}

describe('tab strip rows', () => {
  it('hands every row kind the setting so no pinned tab keeps its label', () => {
    expect(ITEMS).toHaveLength(5)
    expect(iconOnlyFlags(true)).toEqual([true, true, true, true, true])
    expect(iconOnlyFlags(false)).toEqual([false, false, false, false, false])
  })
})

describe('tab strip layout key', () => {
  // The strip measures its overflow off this key, so a resize it cannot see leaves stale scroll math.
  it('re-keys when pinned tabs collapse to their icon', () => {
    const on = buildTabStripLayoutKey(ITEMS, false, {}, new Map(), true)
    const off = buildTabStripLayoutKey(ITEMS, false, {}, new Map(), false)

    expect(on).not.toBe(off)
  })
})
