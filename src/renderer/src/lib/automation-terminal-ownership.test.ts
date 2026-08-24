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
  | 'shutdownCompletedAgentPaneForHibernation'
>

function createStore() {
  const closeTab = vi.fn()
  const shutdownCompletedAgentPaneForHibernation = vi.fn().mockResolvedValue(undefined)
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
    closeTab,
    shutdownCompletedAgentPaneForHibernation
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
  return {
    closeTab,
    getState: () => state,
    shutdownCompletedAgentPaneForHibernation,
    store,
    update
  }
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

  it('hibernates the exact fresh desktop session once after automation completion', async () => {
    const { closeTab, shutdownCompletedAgentPaneForHibernation, store } = createStore()
    const ownership = own(store)

    expect(await ownership.finalize()).toBe(true)
    expect(await ownership.finalize()).toBe(false)
    expect(shutdownCompletedAgentPaneForHibernation).toHaveBeenCalledOnce()
    expect(shutdownCompletedAgentPaneForHibernation).toHaveBeenCalledWith(WORKTREE_ID, {
      paneKey: PANE_KEY,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      ptyId: PTY_ID
    })
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('keeps live terminal identity when hibernation fails', async () => {
    const { closeTab, shutdownCompletedAgentPaneForHibernation, store } = createStore()
    const error = new Error('capture failed')
    shutdownCompletedAgentPaneForHibernation.mockRejectedValueOnce(error)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ownership = own(store)

    expect(await ownership.finalize()).toBe(false)
    expect(await ownership.finalize()).toBe(false)
    expect(consoleError).toHaveBeenCalledWith(
      '[automations] Failed to hibernate owned automation terminal:',
      error
    )
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('preserves a tab activated after launch even when focus later moves away', async () => {
    const { closeTab, store, update } = createStore()
    const ownership = own(store)

    update({ activeWorktreeId: WORKTREE_ID, activeTabId: TAB_ID })
    update({ activeWorktreeId: 'other-worktree', activeTabId: 'other-tab' })

    expect(await ownership.finalize()).toBe(false)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('preserves a tab that received user input after launch', async () => {
    const { closeTab, store, update } = createStore()
    const ownership = own(store)

    update({ lastTerminalInputAtByPaneKey: { [PANE_KEY]: 200 } })

    expect(await ownership.finalize()).toBe(false)
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
  ])('refuses a replacement identity in the %s binding', async (_label, drift) => {
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

    expect(await ownership.finalize()).toBe(false)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('refuses a tab recreated with the same id', async () => {
    const { closeTab, getState, store, update } = createStore()
    const ownership = own(store)
    update({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          { ...getState().tabsByWorktree[WORKTREE_ID]![0]!, createdAt: CREATED_AT + 1 }
        ]
      }
    })

    expect(await ownership.finalize()).toBe(false)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it.each([
    ['remote runtime', { runtimeKind: 'environment' as const }],
    ['remote PTY identity', { ptyId: 'remote:env-1@@terminal-1' }]
  ])('never owns a %s terminal', async (_label, overrides) => {
    const { closeTab, store } = createStore()
    const ownership = own(store, overrides)

    expect(await ownership.finalize()).toBe(false)
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('release consumes ownership without closing the terminal', async () => {
    const { closeTab, store } = createStore()
    const ownership = own(store)

    ownership.release()

    expect(await ownership.finalize()).toBe(false)
    expect(closeTab).not.toHaveBeenCalled()
  })
})
