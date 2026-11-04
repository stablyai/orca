import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/workspace-layout/terminal-tab-types'
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

  it('cycles through native chat tabs when ordered between terminal tabs (#37462)', () => {
    const term1 = unifiedTab({ id: 'unified-term-1', entityId: 'term-1', contentType: 'terminal' })
    const chatTab = unifiedTab({
      id: CHAT_UNIFIED_ID,
      entityId: SESSION_ID,
      contentType: 'agent-session'
    })
    const term2 = unifiedTab({ id: 'unified-term-2', entityId: 'term-2', contentType: 'terminal' })

    const setupState = (activeUnifiedTabId: string) => {
      const activeTab =
        activeUnifiedTabId === CHAT_UNIFIED_ID
          ? chatTab
          : activeUnifiedTabId === 'unified-term-1'
            ? term1
            : term2
      const rawState = {
        activeBrowserTabIdByWorktree: {},
        activeFileIdByWorktree: {},
        activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
        activeTabIdByWorktree: {
          [WORKTREE_ID]: activeTab.contentType === 'terminal' ? activeTab.entityId : 'term-1'
        },
        activeTabTypeByWorktree: { [WORKTREE_ID]: activeTab.contentType },
        activeWorktreeId: WORKTREE_ID,
        browserTabsByWorktree: {},
        groupsByWorktree: {
          [WORKTREE_ID]: [
            {
              id: GROUP_ID,
              worktreeId: WORKTREE_ID,
              activeTabId: activeUnifiedTabId,
              tabOrder: [term1.id, chatTab.id, term2.id]
            }
          ]
        },
        layoutByWorktree: {},
        openFiles: [],
        tabBarOrderByWorktree: {},
        tabsByWorktree: {
          [WORKTREE_ID]: [
            { id: 'term-1', worktreeId: WORKTREE_ID } as TerminalTab,
            { id: 'term-2', worktreeId: WORKTREE_ID } as TerminalTab
          ]
        },
        unifiedTabsByWorktree: { [WORKTREE_ID]: [term1, chatTab, term2] },
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
      store.getActiveTab = createTabsFocusActions(
        noopSet,
        (() => store) as TabsSliceGet
      ).getActiveTab
      return store
    }

    // Step forward from term-1 -> chatTab
    mocks.store = setupState(term1.id)
    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(mocks.store.activateTab).toHaveBeenCalledWith(CHAT_UNIFIED_ID)
    expect(mocks.store.setActiveTabType).toHaveBeenCalledWith('agent-session', WORKTREE_ID)

    // Step forward from chatTab -> term-2
    mocks.store = setupState(CHAT_UNIFIED_ID)
    expect(handleSwitchTerminalTab(1)).toBe(true)
    expect(mocks.store.setActiveTab).toHaveBeenCalledWith('term-2')
    expect(mocks.store.setActiveTabType).toHaveBeenCalledWith('terminal', WORKTREE_ID)

    // Step backward from term-2 -> chatTab
    mocks.store = setupState(term2.id)
    expect(handleSwitchTerminalTab(-1)).toBe(true)
    expect(mocks.store.activateTab).toHaveBeenCalledWith(CHAT_UNIFIED_ID)
    expect(mocks.store.setActiveTabType).toHaveBeenCalledWith('agent-session', WORKTREE_ID)

    // Step backward from chatTab -> term-1
    mocks.store = setupState(CHAT_UNIFIED_ID)
    expect(handleSwitchTerminalTab(-1)).toBe(true)
    expect(mocks.store.setActiveTab).toHaveBeenCalledWith('term-1')
    expect(mocks.store.setActiveTabType).toHaveBeenCalledWith('terminal', WORKTREE_ID)
  })
})
