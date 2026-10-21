// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { TerminalController } from './use-terminal-controller'

vi.mock('../store', async () => {
  const { create } = await import('zustand')
  const activeGroupIdByWorktree: Record<string, string | undefined> = {}
  const groupsByWorktree: Record<string, TabGroup[]> = {}
  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  const unifiedTabsByWorktree: Record<string, Tab[]> = {}
  const useAppStore = create(() => ({
    activeGroupIdByWorktree,
    groupsByWorktree,
    tabsByWorktree,
    unifiedTabsByWorktree,
    consumeSuppressedPtyExit: () => false,
    focusGroup: () => {},
    reconcileWorktreeTabModel: () => ({ renderableTabCount: 1 }),
    setActiveWorktree: () => {}
  }))
  return { useAppStore }
})
vi.mock('./native-chat/use-native-chat-toggle-shortcut', () => ({
  useNativeChatToggleShortcut: () => {}
}))
vi.mock('./terminal-pane/use-terminal-tab-cold-parking', () => ({
  useTerminalTabColdParking: () => new Set()
}))
vi.mock('./terminal-pane/TerminalOverlaySlot', () => ({
  TerminalOverlaySlot: (props: { terminalTabId: string }) => (
    <div data-terminal-pane-tab-id={props.terminalTabId} />
  )
}))
vi.mock('./terminal-pane/TerminalPane', () => ({
  default: (props: { tabId: string }) => <div data-terminal-pane-tab-id={props.tabId} />
}))
vi.mock('./tab-group/RetainedPaneHost', () => ({
  RetainedPaneHost: (props: { groupId?: string; children: React.ReactNode }) => (
    <div data-retained-pane-group-id={props.groupId}>{props.children}</div>
  )
}))

import { useAppStore } from '../store'
import TerminalPaneOverlayLayer from './terminal-pane/TerminalPaneOverlayLayer'
import { TerminalLegacyTerminalPanes } from './TerminalLegacyTerminalPanes'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const WORKTREE_ID = 'repo::/held'
const GROUP_ID = 'group-a'
const NO_ADMITTED_TABS: ReadonlySet<string> = new Set()

function terminalTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: WORKTREE_ID,
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    generation: 0
  }
}

function unifiedTerminalTab(id: string): Tab {
  return {
    id: `unified-${id}`,
    entityId: id,
    worktreeId: WORKTREE_ID,
    groupId: GROUP_ID,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function setTabs(tabIds: string[], activeTabId: string): void {
  const group: TabGroup = {
    id: GROUP_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: `unified-${activeTabId}`,
    tabOrder: tabIds.map((tabId) => `unified-${tabId}`)
  }
  useAppStore.setState({
    activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
    groupsByWorktree: { [WORKTREE_ID]: [group] },
    tabsByWorktree: { [WORKTREE_ID]: tabIds.map(terminalTab) },
    unifiedTabsByWorktree: { [WORKTREE_ID]: tabIds.map(unifiedTerminalTab) }
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function placeholders(): Element[] {
  return [...container.querySelectorAll('[data-terminal-restoring-placeholder]')]
}

function mountedPaneTabIds(): string[] {
  return [...container.querySelectorAll('[data-terminal-pane-tab-id]')].map(
    (element) => element.getAttribute('data-terminal-pane-tab-id') ?? ''
  )
}

describe('overlay layer under the startup terminal hold', () => {
  function renderOverlay(backgroundMountTabIds: ReadonlySet<string> | null): void {
    act(() =>
      root.render(
        <TerminalPaneOverlayLayer
          worktreeId={WORKTREE_ID}
          worktreePath="/held"
          isWorktreeActive
          backgroundMountTabIds={backgroundMountTabIds}
        />
      )
    )
  }

  it('fills the visible held tab slot, including a tab created under the hold, until the gate opens', () => {
    setTabs(['tab-a', 'tab-b'], 'tab-a')
    renderOverlay(NO_ADMITTED_TABS)
    // Only the visible tab gets a placeholder; the hidden held tab renders nothing.
    expect(placeholders()).toHaveLength(1)
    expect(placeholders()[0].parentElement?.getAttribute('data-retained-pane-group-id')).toBe(
      GROUP_ID
    )
    expect(mountedPaneTabIds()).toEqual([])

    setTabs(['tab-a', 'tab-b', 'tab-new'], 'tab-new')
    renderOverlay(NO_ADMITTED_TABS)
    expect(placeholders()).toHaveLength(1)
    expect(mountedPaneTabIds()).toEqual([])

    renderOverlay(null)
    expect(placeholders()).toHaveLength(0)
    expect(mountedPaneTabIds()).toEqual(['tab-a', 'tab-b', 'tab-new'])
  })

  it('renders no placeholder while the held worktree is not the active one', () => {
    setTabs(['tab-a'], 'tab-a')
    act(() =>
      root.render(
        <TerminalPaneOverlayLayer
          worktreeId={WORKTREE_ID}
          worktreePath="/held"
          isWorktreeActive={false}
          backgroundMountTabIds={NO_ADMITTED_TABS}
        />
      )
    )
    expect(placeholders()).toHaveLength(0)
  })
})

describe('legacy terminal panes under the startup terminal hold', () => {
  function renderLegacy(
    tabIds: string[],
    activeTabId: string,
    restriction: ReadonlySet<string> | null
  ): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: TerminalLegacyTerminalPanes reads only the fields listed here.
    const controller = {
      activeTabId,
      activeTabType: 'terminal',
      activeView: 'terminal',
      activityTerminalPortals: [],
      backgroundMountTabIdsByWorktreeRef: {
        current: new Map(restriction ? [[WORKTREE_ID, restriction]] : [])
      },
      effectiveParkedTerminalWorktreeIds: new Set(),
      evictionExemptTerminalTabIds: new Set(),
      handleCloseTab: () => {},
      handlePtyExit: () => {},
      measurableBackgroundWorktreeIdsRef: { current: new Set() },
      mountedWorktreeIdsRef: { current: new Set([WORKTREE_ID]) },
      renderedActiveWorktreeId: WORKTREE_ID,
      tabsByWorktree: { [WORKTREE_ID]: tabIds.map(terminalTab) },
      worktreeBrowserTabs: [],
      worktreeFiles: [],
      workspaceSurfaces: [{ id: WORKTREE_ID, path: '/held' }]
    } as unknown as TerminalController
    act(() => root.render(<TerminalLegacyTerminalPanes controller={controller} />))
  }

  it('fills the active held tab, including a tab created under the hold, until the gate opens', () => {
    renderLegacy(['tab-a', 'tab-b'], 'tab-a', NO_ADMITTED_TABS)
    expect(placeholders()).toHaveLength(1)
    expect(mountedPaneTabIds()).toEqual([])

    renderLegacy(['tab-a', 'tab-b', 'tab-new'], 'tab-new', NO_ADMITTED_TABS)
    expect(placeholders()).toHaveLength(1)

    renderLegacy(['tab-a', 'tab-b', 'tab-new'], 'tab-new', null)
    expect(placeholders()).toHaveLength(0)
    expect(mountedPaneTabIds()).toEqual(['tab-a', 'tab-b', 'tab-new'])
  })

  it('renders no placeholder when the active tab is not a held one', () => {
    renderLegacy(['tab-a', 'tab-b'], 'tab-a', new Set(['tab-a']))
    expect(placeholders()).toHaveLength(0)
    expect(mountedPaneTabIds()).toEqual(['tab-a'])
  })
})
