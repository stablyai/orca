// @vitest-environment happy-dom

// A structured chat tab is projected into SortableTab, which renders `title` exactly as given. The
// provider name therefore has to be resolved here, or the strip keeps showing the generic label.

import type React from 'react'
import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { getTabDragLabel, type TabBarItem } from './tab-bar-item-model'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import { renderTabBarItems } from './tab-bar-item-surface'

const RESOLVED = { agent: 'claude' as const, sessionId: 'provider-1', title: 'Fix the probe' }

function chatTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'agent-session:session-1',
    entityId: 'session-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    agentSessionProviderSessionId: 'provider-1',
    label: 'Claude Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  } as Tab
}

function chatItem(tab: Tab): TabBarItem {
  return {
    type: 'agent-session',
    id: tab.id,
    unifiedTabId: tab.id,
    isPinned: false,
    data: tab
  } as TabBarItem
}

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

const PROPS = {
  worktreeId: 'wt-1',
  activeTabId: null,
  activeFileId: null,
  activeBrowserTabId: null,
  activeSimulatorTabId: null,
  activeTabType: 'agent-session',
  groupActiveTabId: null,
  expandedPaneByTabId: {}
} as unknown as TabBarProps

/** What SortableTab will render for this chat tab. */
function renderedTitle(tab: Tab): string {
  const [node] = renderTabBarItems({
    items: [chatItem(tab)],
    props: PROPS,
    runtime: RUNTIME,
    dropIndicatorByVisibleId: new Map(),
    includeTopTabBorder: true,
    activeClientHostedBrowserRowId: null,
    togglePinned: () => {}
  })
  return (node as React.ReactElement<{ tab: TerminalTab }>).props.tab.title
}

describe('structured chat tab label in the strip', () => {
  it('shows the generic label until a provider name is resolved', () => {
    expect(renderedTitle(chatTab())).toBe('Claude Chat')
  })

  it('shows the resolved provider name', () => {
    expect(renderedTitle(chatTab({ aiVaultTitle: RESOLVED }))).toBe('Fix the probe')
  })

  it('keeps a manual rename above the provider name, and reveals it again when cleared', () => {
    const renamed = chatTab({ aiVaultTitle: RESOLVED, customLabel: 'My rename' })
    const node = renderTabBarItems({
      items: [chatItem(renamed)],
      props: PROPS,
      runtime: RUNTIME,
      dropIndicatorByVisibleId: new Map(),
      includeTopTabBorder: true,
      activeClientHostedBrowserRowId: null,
      togglePinned: () => {}
    })[0] as React.ReactElement<{ tab: TerminalTab }>
    // SortableTab renders `customTitle ?? title`, so the rename must arrive on customTitle.
    expect(node.props.tab.customTitle).toBe('My rename')

    expect(renderedTitle({ ...renamed, customLabel: null })).toBe('Fix the probe')
  })

  it('drags under the same name the strip shows', () => {
    expect(getTabDragLabel(chatItem(chatTab({ aiVaultTitle: RESOLVED })), false)).toBe(
      'Fix the probe'
    )
  })
})
