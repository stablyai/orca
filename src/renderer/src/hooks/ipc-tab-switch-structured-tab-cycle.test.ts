import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AppState } from '@/store/types'
import { createTabsFocusActions } from '../store/slices/tabs/tabs-focus-actions'
import type { TabsSliceGet, TabsSliceSet } from '../store/slices/tabs/tabs-slice-contract'
import { buildActiveSurfacePatch } from '../store/slices/tabs/tabs-surface'

const mocks = vi.hoisted(() => ({ store: {} as AppState }))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))

import { handleSwitchTerminalTab } from './ipc-tab-switch'
import { switchFloatingWorkspaceTab } from '@/lib/floating-workspace-terminal-actions'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))

const WORKTREE_ID = 'wt-1'
const GROUP_ID = 'group-1'
const SESSION_ID = 'sess-1'
const CHAT_UNIFIED_ID = `structured-agent-session-${SESSION_ID}`

function unifiedTab(overrides: Partial<Tab> & Pick<Tab, 'id' | 'entityId' | 'contentType'>): Tab {
  return {
    groupId: GROUP_ID,
    worktreeId: WORKTREE_ID,
    label: overrides.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

/** Build real active-surface state so structured focus leaves the legacy terminal ID stale, reproducing the ownership seam. */
function storeWithStructuredTabActive({
  terminalIds,
  lastFocusedTerminalId,
  activeGroupTabId = CHAT_UNIFIED_ID
}: {
  terminalIds: string[]
  lastFocusedTerminalId: string
  activeGroupTabId?: string
}): AppState {
  const terminalTabs = terminalIds.map((id) =>
    unifiedTab({ id: `unified-${id}`, entityId: id, contentType: 'terminal' })
  )
  const chatTab = unifiedTab({
    id: CHAT_UNIFIED_ID,
    entityId: SESSION_ID,
    contentType: 'agent-session'
  })
  const groups: TabGroup[] = [
    {
      id: GROUP_ID,
      worktreeId: WORKTREE_ID,
      activeTabId: activeGroupTabId,
      tabOrder: [...terminalTabs.map((tab) => tab.id), chatTab.id]
    }
  ]
  const rawState = {
    activeBrowserTabIdByWorktree: {},
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
    activeTabIdByWorktree: { [WORKTREE_ID]: lastFocusedTerminalId },
    activeTabTypeByWorktree: {},
    activeWorktreeId: WORKTREE_ID,
    browserTabsByWorktree: {},
    groupsByWorktree: { [WORKTREE_ID]: groups },
    layoutByWorktree: {},
    openFiles: [],
    tabBarOrderByWorktree: {},
    tabsByWorktree: {
      [WORKTREE_ID]: terminalIds.map((id) => ({ id, worktreeId: WORKTREE_ID }) as TerminalTab)
    },
    unifiedTabsByWorktree: { [WORKTREE_ID]: [...terminalTabs, chatTab] },
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    activateTab: vi.fn(),
    setActiveFile: vi.fn(),
    setActiveBrowserTab: vi.fn()
  } as unknown as AppState
  const store = {
    ...rawState,
    ...buildActiveSurfacePatch(rawState, WORKTREE_ID)
  } as AppState
  const noopSet = (() => {}) as unknown as TabsSliceSet
  store.getActiveTab = createTabsFocusActions(noopSet, (() => store) as TabsSliceGet).getActiveTab
  return store
}

describe('handleSwitchTerminalTab with a structured chat tab active', () => {
  beforeEach(() => vi.clearAllMocks())

  it('jumps to the first terminal instead of cycling from the background terminal', () => {
    mocks.store = storeWithStructuredTabActive({
      terminalIds: ['term-1', 'term-2', 'term-3'],
      lastFocusedTerminalId: 'term-2'
    })
    expect(handleSwitchTerminalTab(1)).toBe(true)
    // Stepping from the stale 'term-2' would land on 'term-3'.
    expect(mocks.store.setActiveTab).toHaveBeenCalledWith('term-1')
    expect(mocks.store.setActiveTab).not.toHaveBeenCalledWith('term-3')
    expect(mocks.store.setActiveTabType).toHaveBeenCalledWith('terminal', 'wt-1')
  })

  it('still reaches the sole terminal rather than reading as already focused', () => {
    mocks.store = storeWithStructuredTabActive({
      terminalIds: ['term-1'],
      lastFocusedTerminalId: 'term-1'
    })
    // The stale id matched the only terminal, so the single-terminal guard swallowed the chord.
    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(mocks.store.setActiveTab).toHaveBeenCalledWith('term-1')
  })
})

describe.each(['main', 'floating'] as const)('%s terminal shortcut chat order', (surface) => {
  it('cycles terminal, chat, terminal in both directions using exact tab selection', () => {
    const worktreeId = surface === 'floating' ? FLOATING_TERMINAL_WORKTREE_ID : WORKTREE_ID
    const store = storeWithStructuredTabActive({
      terminalIds: ['term-1', 'term-2'],
      lastFocusedTerminalId: 'term-1',
      activeGroupTabId: 'unified-term-1'
    })
    store.activeWorktreeId = worktreeId
    store.activeGroupIdByWorktree = { [worktreeId]: GROUP_ID }
    store.groupsByWorktree = {
      [worktreeId]: store.groupsByWorktree[WORKTREE_ID].map((group) => ({ ...group, worktreeId }))
    }
    store.tabsByWorktree = {
      [worktreeId]: store.tabsByWorktree[WORKTREE_ID].map((tab) => ({ ...tab, worktreeId }))
    }
    store.unifiedTabsByWorktree = {
      [worktreeId]: store.unifiedTabsByWorktree[WORKTREE_ID].map((tab) => ({ ...tab, worktreeId }))
    }
    mocks.store = store
    const group = store.groupsByWorktree[worktreeId][0]
    group.tabOrder = ['unified-term-1', CHAT_UNIFIED_ID, 'unified-term-2']
    vi.mocked(store.activateTab).mockImplementation((tabId) => {
      group.activeTabId = tabId
      Object.assign(store, buildActiveSurfacePatch(store, worktreeId))
    })
    const switchTab = (direction: number): boolean =>
      surface === 'floating'
        ? switchFloatingWorkspaceTab(store, direction, 'terminal')
        : handleSwitchTerminalTab(direction)
    for (const [direction, expectedTabId] of [
      [1, CHAT_UNIFIED_ID],
      [1, 'unified-term-2'],
      [1, 'unified-term-1'],
      [-1, 'unified-term-2'],
      [-1, CHAT_UNIFIED_ID],
      [-1, 'unified-term-1']
    ] as const) {
      expect(switchTab(direction)).toBe(true)
      expect(group.activeTabId).toBe(expectedTabId)
    }
  })
})
