import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValidElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import {
  buildOrderedTabItems,
  buildTabStripLayoutKey,
  findActiveVisibleTabId,
  getTabDragLabel,
  type TabBarItem
} from './tab-bar-item-model'
import { renderTabBarItems } from './tab-bar-item-surface'
import { resolveTabGroupPanelActiveTabProps } from '../tab-group/tab-group-panel-active-tab-props'

function makeAgentsTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'agents-tab',
    entityId: 'agents:wt-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'agents',
    label: 'Agents',
    customLabel: null,
    color: null,
    sortOrder: 1,
    createdAt: 1,
    isPinned: true,
    ...overrides
  }
}

function makeAgentsItem(overrides: Partial<Tab> = {}): TabBarItem {
  const tab = makeAgentsTab(overrides)
  return {
    type: 'agents',
    id: tab.id,
    unifiedTabId: tab.id,
    isPinned: tab.isPinned === true,
    data: tab
  }
}

const TERMINAL_ITEM: TabBarItem = {
  type: 'terminal',
  id: 'term-1',
  unifiedTabId: 'unified-term-1',
  isPinned: false,
  data: {
    id: 'term-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

const TERMINAL_UNIFIED_TAB: Tab = {
  id: 'unified-term-1',
  entityId: TERMINAL_ITEM.id,
  groupId: 'group-1',
  worktreeId: 'wt-1',
  contentType: 'terminal',
  label: 'Terminal 1',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

const noop = (): void => {}

const RUNTIME: TabBarRuntimeModel = {
  newTerminalShortcut: '',
  newBrowserShortcut: '',
  newSimulatorShortcut: '',
  newFileShortcut: '',
  openMarkdownShortcut: null,
  generatedTabTitlesEnabled: false,
  mobileEmulatorEnabled: false,
  showMobileEmulatorIntroCallout: false,
  unifiedTabs: [],
  pinTab: noop,
  unpinTab: noop,
  defaultWindowsShell: 'powershell.exe',
  defaultWindowsPowerShellImplementation: 'auto',
  agentLaunchOptions: [],
  windowsTerminalCapabilities: {
    wslAvailable: false,
    wslDistros: [],
    pwshAvailable: false,
    gitBashAvailable: false,
    hostPlatform: null,
    isLoading: false
  },
  showWindowsShellMenu: false,
  projectRuntimeShellMenuMode: null,
  resolvedGroupId: 'group-1',
  statusByRelativePath: new Map(),
  unifiedTabByVisibleId: new Map(),
  workspaceHasSimulatorTab: false,
  toggleTabViewMode: noop,
  nativeChatTranscriptIsLocalReadable: false,
  managedBrowserCreationEnabled: false,
  mobileEmulatorCreationEnabled: false,
  nativeChatEnabled: false,
  tabAgentTypesByTabId: {},
  nativeChatTabWideFallbackUnsafeTabsById: {}
}

/** Derives activeTabId/activeFileId/activeTabType from TabGroupPanel's own projection
 *  (see B2) instead of hand-feeding literals, so a broken projection fails this test. */
function makeProps(activeTab: Tab | null): TabBarProps {
  return {
    tabs: [],
    ...resolveTabGroupPanelActiveTabProps(activeTab),
    worktreeId: 'wt-1',
    expandedPaneByTabId: {},
    onActivate: noop,
    onClose: noop,
    onCloseOthers: noop,
    onCloseToRight: noop,
    onCloseToLeft: noop,
    onNewTerminalTab: noop,
    onNewBrowserTab: noop,
    onSetCustomTitle: noop,
    onSetTabColor: noop,
    onTogglePaneExpand: noop,
    activeBrowserTabId: null,
    activeSimulatorTabId: null,
    groupActiveTabId: activeTab?.id ?? null
  }
}

describe('agents strip item', () => {
  it('builds a pinned agents arm from a contentType agents tab in tabOrder', () => {
    const agentsTab = makeAgentsTab()
    const items = buildOrderedTabItems({
      tabBarOrder: ['term-1', agentsTab.id],
      terminalIds: ['term-1'],
      editorFileIds: [],
      browserTabIds: [],
      simulatorTabIds: [],
      agentSessionTabIds: [],
      agentsTabIds: [agentsTab.id],
      terminalMap: new Map([['term-1', TERMINAL_ITEM.data]]),
      editorMap: new Map(),
      browserMap: new Map(),
      agentSessionMap: new Map(),
      unifiedTabByVisibleId: new Map([[agentsTab.id, agentsTab]])
    })

    expect(items.map((item) => item.type)).toEqual(['terminal', 'agents'])
    expect(items[1]).toMatchObject({
      type: 'agents',
      id: agentsTab.id,
      unifiedTabId: agentsTab.id,
      isPinned: true
    })
  })

  it('highlights the agents item only when it is the active tab', () => {
    const agentsTab = makeAgentsTab()
    const agentsItem = makeAgentsItem()
    const items = [TERMINAL_ITEM, agentsItem]
    // Why: derive activeTabId/activeTabType from TabGroupPanel's own projection (B2)
    // rather than hand-feeding agentsItem.id, so a broken projection fails this test.
    const { activeTabId, activeTabType } = resolveTabGroupPanelActiveTabProps(agentsTab)
    expect(findActiveVisibleTabId(items, { activeTabId, activeTabType })).toBe(agentsItem.id)
    expect(
      findActiveVisibleTabId(items, resolveTabGroupPanelActiveTabProps(TERMINAL_UNIFIED_TAB))
    ).toBe(TERMINAL_ITEM.id)
  })

  it('returns the tab label for drag and changes the strip layout key when the label changes', () => {
    const named = makeAgentsItem({ label: 'Agents' })
    const renamed = makeAgentsItem({ label: 'Team agents' })
    expect(getTabDragLabel(named, false)).toBe('Agents')
    expect(getTabDragLabel(renamed, false)).toBe('Team agents')
    expect(buildTabStripLayoutKey([named], false, {}, new Map())).not.toBe(
      buildTabStripLayoutKey([renamed], false, {}, new Map())
    )
  })

  it('renders a pinned EditorFileTab that opts back into a close button', () => {
    const onCloseFile = vi.fn()
    const agentsTab = makeAgentsTab()
    const agentsItem = makeAgentsItem()
    const rendered = renderTabBarItems({
      items: [TERMINAL_ITEM, agentsItem],
      props: { ...makeProps(agentsTab), onCloseFile },
      runtime: RUNTIME,
      dropIndicatorByVisibleId: new Map(),
      includeTopTabBorder: true,
      activeClientHostedBrowserRowId: null,
      togglePinned: () => {}
    })

    const agentsNode = rendered[1]
    if (!isValidElement(agentsNode)) {
      throw new Error('expected agents strip item')
    }
    expect(agentsNode.props).toMatchObject({
      isPinned: true,
      // Why it opts in: closing this tab is a real action that prompts about the agents it
      // hosts, so hiding the control would leave the user with no way to ask for it.
      showCloseWhenPinned: true,
      isActive: true,
      file: { filePath: 'Agents', language: 'agents' }
    })

    const terminalActive = renderTabBarItems({
      items: [TERMINAL_ITEM, agentsItem],
      props: makeProps(TERMINAL_UNIFIED_TAB),
      runtime: RUNTIME,
      dropIndicatorByVisibleId: new Map(),
      includeTopTabBorder: true,
      activeClientHostedBrowserRowId: null,
      togglePinned: () => {}
    })
    const inactiveAgents = terminalActive[1]
    if (!isValidElement(inactiveAgents)) {
      throw new Error('expected agents strip item')
    }
    expect(inactiveAgents.props).toMatchObject({ isActive: false })

    const editorFileTabSource = readFileSync(
      join(__dirname, 'EditorFileTab.tsx'),
      'utf8'
    ).replaceAll('\r\n', '\n')
    expect(editorFileTabSource).toContain('{(!isPinned || showCloseWhenPinned) && (')
    // Middle-click still bails on every pinned tab; only the explicit X is offered here.
    expect(editorFileTabSource).toContain('if (isPinned) {\n            return\n          }')
    expect(onCloseFile).not.toHaveBeenCalled()
  })
})
