import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import {
  createAutomationTerminalOwnership,
  type AutomationTerminalOwnershipStore
} from './automation-terminal-ownership'

const WORKTREE_ID = 'worktree-1'
const TAB_ID = 'tab-1'
const LEAF_ID = '7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'pty-1'
const CREATED_AT = 100

type OwnershipState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeTabId'
  | 'activeTabType'
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'lastTerminalInputAtByPaneKey'
  | 'closeTab'
>

function createStore() {
  const closeTab = vi.fn()
  let state: OwnershipState = {
    activeWorktreeId: 'other-worktree',
    activeTabId: 'other-tab',
    activeTabType: 'terminal' as const,
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          worktreeId: WORKTREE_ID,
          ptyId: PTY_ID,
          title: 'Automation',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: CREATED_AT
        }
      ]
    },
    ptyIdsByTabId: { [TAB_ID]: [PTY_ID] },
    terminalLayoutsByTabId: {
      [TAB_ID]: singlePaneLayoutSnapshot(LEAF_ID, PTY_ID)
    },
    lastTerminalInputAtByPaneKey: {},
    closeTab
  }
  const listeners = new Set<(state: AppState, previousState: AppState) => void>()
  const store: AutomationTerminalOwnershipStore = {
    getState: () => state as unknown as AppState,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const update = (patch: Partial<OwnershipState>): void => {
    const previousState = state
    state = { ...state, ...patch }
    for (const listener of listeners) {
      listener(state as unknown as AppState, previousState as unknown as AppState)
    }
  }
  return { closeTab, getState: () => state, store, update }
}

function own(
  store: AutomationTerminalOwnershipStore,
  overrides: Partial<Parameters<typeof createAutomationTerminalOwnership>[0]> = {}
) {
  return createAutomationTerminalOwnership({
    store,
    worktreeId: WORKTREE_ID,
    tabId: TAB_ID,
    paneKey: PANE_KEY,
    ptyId: PTY_ID,
    tabCreatedAt: CREATED_AT,
    runtimeKind: 'desktop',
    ...overrides
  })
}

describe('automation terminal ownership', () => {
  beforeEach(() => vi.clearAllMocks())

  it('closes the exact fresh desktop tab once after the PTY exit binding is cleared', () => {
    const { closeTab, store, update } = createStore()
    const ownership = own(store)
    update({
      ptyIdsByTabId: { [TAB_ID]: [] },
      tabsByWorktree: {
        [WORKTREE_ID]: [{ ...store.getState().tabsByWorktree[WORKTREE_ID]![0]!, ptyId: null }]
      }
    })

    expect(ownership.finalize()).toBe(true)
    expect(ownership.finalize()).toBe(false)
    expect(closeTab).toHaveBeenCalledTimes(1)
    expect(closeTab).toHaveBeenCalledWith(TAB_ID, {
      recordInteraction: false,
      reason: 'cleanup'
    })
  })

  it('preserves a tab activated after launch even when focus later moves away', () => {
    const { closeTab, store, update } = createStore()
    const ownership = own(store)

    update({ activeWorktreeId: WORKTREE_ID, activeTabId: TAB_ID })
    update({ activeWorktreeId: 'other-worktree', activeTabId: 'other-tab' })

    expect(ownership.finalize()).toBe(false)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('preserves a tab that received user input after launch', () => {
    const { closeTab, store, update } = createStore()
    const ownership = own(store)

    update({ lastTerminalInputAtByPaneKey: { [PANE_KEY]: 200 } })

    expect(ownership.finalize()).toBe(false)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it.each([
    ['tab PTY', { tabsByWorktree: undefined, ptyIdsByTabId: undefined, layoutPty: undefined }],
    [
      'PTY index',
      { tabsByWorktree: null, ptyIdsByTabId: ['pty-replacement'], layoutPty: undefined }
    ],
    [
      'pane layout',
      { tabsByWorktree: null, ptyIdsByTabId: undefined, layoutPty: 'pty-replacement' }
    ]
  ])('refuses a replacement identity in the %s binding', (_label, drift) => {
    const { closeTab, getState, store, update } = createStore()
    const ownership = own(store)
    const tab = getState().tabsByWorktree[WORKTREE_ID]![0]!
    update({
      ...(drift.tabsByWorktree === undefined
        ? { tabsByWorktree: { [WORKTREE_ID]: [{ ...tab, ptyId: 'pty-replacement' }] } }
        : {}),
      ...(drift.ptyIdsByTabId ? { ptyIdsByTabId: { [TAB_ID]: drift.ptyIdsByTabId } } : {}),
      ...(drift.layoutPty
        ? {
            terminalLayoutsByTabId: {
              [TAB_ID]: {
                ...getState().terminalLayoutsByTabId[TAB_ID]!,
                ptyIdsByLeafId: { [LEAF_ID]: drift.layoutPty }
              }
            }
          }
        : {})
    })

    expect(ownership.finalize()).toBe(false)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('refuses a tab recreated with the same id', () => {
    const { closeTab, getState, store, update } = createStore()
    const ownership = own(store)
    update({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          { ...getState().tabsByWorktree[WORKTREE_ID]![0]!, createdAt: CREATED_AT + 1 }
        ]
      }
    })

    expect(ownership.finalize()).toBe(false)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it.each([
    ['remote runtime', { runtimeKind: 'environment' as const }],
    ['remote PTY identity', { ptyId: 'remote:env-1@@terminal-1' }]
  ])('never owns a %s terminal', (_label, overrides) => {
    const { closeTab, store } = createStore()
    const ownership = own(store, overrides)

    expect(ownership.finalize()).toBe(false)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('release consumes ownership without closing the terminal', () => {
    const { closeTab, store } = createStore()
    const ownership = own(store)

    ownership.release()

    expect(ownership.finalize()).toBe(false)
    expect(closeTab).not.toHaveBeenCalled()
  })
})
