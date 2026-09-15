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

/**
 * The store the app really has with a structured tab focused: raw group state plus the
 * active-surface fields the store derives from it. That derivation is what leaves `activeTabId`
 * naming a live background terminal, so stubbing it would hide the half under test.
 */
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

  it('leaves activeTabId naming a live background terminal', () => {
    // Guards the premise: without a stale id that is really in the terminal list, the tests
    // below would pass with the bug present.
    mocks.store = storeWithStructuredTabActive({
      terminalIds: ['term-1', 'term-2', 'term-3'],
      lastFocusedTerminalId: 'term-2'
    })
    expect(mocks.store.activeTabType).toBe('agent-session')
    expect(mocks.store.activeTabId).toBe('term-2')
  })

  it('jumps to the first terminal instead of cycling from the background terminal', () => {
    mocks.store = storeWithStructuredTabActive({
      terminalIds: ['term-1', 'term-2', 'term-3'],
      lastFocusedTerminalId: 'term-2'
    })
    expect(handleSwitchTerminalTab(1)).toBe(true)
    // Stepping from the stale 'term-2' would land on 'term-3'.
    expect(mocks.store.setActiveTab).toHaveBeenCalledWith('term-1')
    expect(mocks.store.setActiveTab).not.toHaveBeenCalledWith('term-3')
    expect(mocks.store.setActiveTabType).toHaveBeenCalledWith('terminal')
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

  it('still cycles normally from a focused terminal tab', () => {
    mocks.store = storeWithStructuredTabActive({
      terminalIds: ['term-1', 'term-2', 'term-3'],
      lastFocusedTerminalId: 'term-2',
      activeGroupTabId: 'unified-term-2'
    })
    expect(mocks.store.activeTabType).toBe('terminal')
    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(mocks.store.setActiveTab).toHaveBeenCalledWith('term-3')
  })
})
