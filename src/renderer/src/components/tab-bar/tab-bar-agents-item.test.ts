// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { buildOrderedTabItems, buildTabStripLayoutKey, type TabBarItem } from './tab-bar-item-model'
import { findActiveVisibleTabId } from './tab-bar-active-visible-tab'
import { tabItemLabel } from './tab-bar-item-label'
import {
  renderTabBarItems,
  type TabBarItemSurfaceProps,
  type TabBarItemSurfaceRuntime
} from './tab-bar-item-surface'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import { resolveTabGroupPanelActiveTabProps } from '../tab-group/tab-group-panel-active-tab-props'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type EditorTabRender = {
  file: { id: string; filePath: string; language: string }
  isActive: boolean
  isPinned: boolean
  onClose: () => void
}

const editorTabRenders: EditorTabRender[] = []

vi.mock('./EditorFileTab', () => ({
  default: (props: EditorTabRender) => {
    editorTabRenders.push(props)
    return null
  }
}))
vi.mock('./TerminalSortableTab', () => ({ default: () => null }))

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

const RUNTIME: TabBarItemSurfaceRuntime = {
  resolvedGroupId: 'group-1',
  generatedTabTitlesEnabled: false,
  unifiedTabByVisibleId: new Map(),
  tabAgentTypesByTabId: {},
  nativeChatTabWideFallbackUnsafeTabsById: {},
  nativeChatTranscriptIsLocalReadable: false,
  managedBrowserCreationEnabled: false,
  statusByRelativePath: new Map()
}

function makeActions(closeFile: (fileId: string) => void): TabBarItemActions {
  return {
    activateTerminal: noop,
    activateFile: noop,
    activateBrowserTab: noop,
    activateAgentSession: noop,
    close: noop,
    closeFile,
    closeBrowserTab: noop,
    closeOthers: noop,
    closeToRight: noop,
    closeToLeft: noop,
    closeSplitPane: noop,
    closeAllFiles: noop,
    setCustomTitle: noop,
    setTabColor: noop,
    togglePaneExpand: noop,
    duplicateBrowserTab: noop,
    makePreviewFilePermanent: noop,
    togglePinned: noop,
    toggleViewMode: noop
  }
}

/** Derives activeTabId/activeFileId/activeTabType from TabGroupPanel's own projection
 *  (see B2) instead of hand-feeding literals, so a broken projection fails this test. */
function makeProps(activeTab: Tab | null): TabBarItemSurfaceProps {
  return {
    ...resolveTabGroupPanelActiveTabProps(activeTab),
    worktreeId: 'wt-1',
    expandedPaneByTabId: {},
    activeBrowserTabId: null,
    activeSimulatorTabId: null
  }
}

function renderAgentsRow(activeTab: Tab, closeFile: (fileId: string) => void): EditorTabRender {
  editorTabRenders.length = 0
  const root = createRoot(document.createElement('div'))
  act(() =>
    root.render(
      createElement(
        Fragment,
        null,
        renderTabBarItems({
          items: [TERMINAL_ITEM, makeAgentsItem()],
          props: makeProps(activeTab),
          runtime: RUNTIME,
          actions: makeActions(closeFile),
          dropIndicatorByVisibleId: new Map(),
          includeTopTabBorder: true,
          activeClientHostedBrowserRowId: null
        })
      )
    )
  )
  act(() => root.unmount())
  const agentsRender = editorTabRenders.findLast((render) => render.file.language === 'agents')
  if (!agentsRender) {
    throw new Error('expected agents strip item')
  }
  return agentsRender
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
    expect(tabItemLabel(named, false, null)).toBe('Agents')
    expect(tabItemLabel(renamed, false, null)).toBe('Team agents')
    expect(buildTabStripLayoutKey([named], false, {}, new Map(), new Map())).not.toBe(
      buildTabStripLayoutKey([renamed], false, {}, new Map(), new Map())
    )
  })

  it('renders a pinned EditorFileTab that opts back into a close button', () => {
    const onCloseFile = vi.fn()
    const agentsTab = makeAgentsTab()
    const agentsRender = renderAgentsRow(agentsTab, onCloseFile)
    expect(agentsRender).toMatchObject({
      isPinned: true,
      isActive: true,
      file: { filePath: 'Agents', language: 'agents' }
    })
    expect(onCloseFile).not.toHaveBeenCalled()
    agentsRender.onClose()
    expect(onCloseFile).toHaveBeenCalledWith(agentsTab.id)

    expect(renderAgentsRow(TERMINAL_UNIFIED_TAB, noop)).toMatchObject({ isActive: false })

    const editorFileTabSource = readFileSync(
      join(__dirname, 'EditorFileTab.tsx'),
      'utf8'
    ).replaceAll('\r\n', '\n')
    expect(editorFileTabSource).toContain("{(!isPinned || file.language === 'agents') && (")
    // Middle-click still bails on every pinned tab; only the explicit X is offered here.
    expect(editorFileTabSource).toContain('if (isPinned) {\n            return\n          }')
  })
})
