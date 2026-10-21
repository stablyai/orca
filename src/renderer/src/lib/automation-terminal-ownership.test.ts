import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
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
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'agentLaunchConfigByPaneKey'
  | 'closeTab'
  | 'shutdownCompletedAgentPaneForHibernation'
>

// A finished Claude turn whose hook reported its conversation id, as a live run leaves it.
const RESUMABLE_DONE_ENTRY: AgentStatusEntry = {
  state: 'done',
  prompt: 'Reply with pineapple',
  updatedAt: 300,
  stateStartedAt: 300,
  paneKey: PANE_KEY,
  worktreeId: WORKTREE_ID,
  agentType: 'claude',
  providerSession: { key: 'session_id', id: 'c569e233-595e-4085-8660-5af742f81e59' },
  stateHistory: []
}

function createStore() {
  const closeTab = vi.fn()
  const shutdownCompletedAgentPaneForHibernation = vi.fn(async () => {})
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
    agentStatusByPaneKey: { [PANE_KEY]: RESUMABLE_DONE_ENTRY },
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
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

  it('closes the exact fresh desktop tab once after the PTY exit binding is cleared', async () => {
    const { closeTab, store, update } = createStore()
    const ownership = own(store)
    update({
      ptyIdsByTabId: { [TAB_ID]: [] },
      tabsByWorktree: {
        [WORKTREE_ID]: [{ ...store.getState().tabsByWorktree[WORKTREE_ID]![0]!, ptyId: null }]
      }
    })

    expect(await ownership.finalize({ preservePane: false })).toBe('closed')
    expect(await ownership.finalize({ preservePane: false })).toBeNull()
    expect(closeTab).toHaveBeenCalledTimes(1)
    expect(closeTab).toHaveBeenCalledWith(TAB_ID, {
      recordInteraction: false,
      reason: 'cleanup'
    })
  })

  it('preserves a tab activated after launch even when focus later moves away', async () => {
    const { closeTab, store, update } = createStore()
    const ownership = own(store)

    update({ activeWorktreeId: WORKTREE_ID, activeTabId: TAB_ID })
    update({ activeWorktreeId: 'other-worktree', activeTabId: 'other-tab' })

    expect(await ownership.finalize({ preservePane: false })).toBeNull()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('preserves a tab that received user input after launch', async () => {
    const { closeTab, store, update } = createStore()
    const ownership = own(store)

    update({ lastTerminalInputAtByPaneKey: { [PANE_KEY]: 200 } })

    expect(await ownership.finalize({ preservePane: false })).toBeNull()
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

    expect(await ownership.finalize({ preservePane: false })).toBeNull()
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

    expect(await ownership.finalize({ preservePane: false })).toBeNull()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it.each([
    ['remote runtime', { runtimeKind: 'environment' as const }],
    ['remote PTY identity', { ptyId: 'remote:env-1@@terminal-1' }]
  ])('never owns a %s terminal', async (_label, overrides) => {
    const { closeTab, store } = createStore()
    const ownership = own(store, overrides)

    expect(await ownership.finalize({ preservePane: false })).toBeNull()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('sleeps a resumable pane in a workspace the run owns instead of closing it', async () => {
    const { closeTab, shutdownCompletedAgentPaneForHibernation, store } = createStore()
    const ownership = own(store)

    expect(await ownership.finalize({ preservePane: true })).toBe('hibernated')
    expect(shutdownCompletedAgentPaneForHibernation).toHaveBeenCalledExactlyOnceWith(WORKTREE_ID, {
      paneKey: PANE_KEY,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      ptyId: PTY_ID
    })
    expect(closeTab).not.toHaveBeenCalled()
  })

  it.each([
    ['the agent reported no conversation id', { providerSession: undefined }, [PTY_ID]],
    ['the run ended by its process exiting', {}, []]
  ])('closes the tab when %s', async (_label, entryPatch, livePtyIds) => {
    const { closeTab, shutdownCompletedAgentPaneForHibernation, store, update } = createStore()
    const ownership = own(store)
    update({
      agentStatusByPaneKey: { [PANE_KEY]: { ...RESUMABLE_DONE_ENTRY, ...entryPatch } },
      ptyIdsByTabId: { [TAB_ID]: livePtyIds }
    })

    expect(await ownership.finalize({ preservePane: true })).toBe('closed')
    expect(shutdownCompletedAgentPaneForHibernation).not.toHaveBeenCalled()
    expect(closeTab).toHaveBeenCalledTimes(1)
  })

  it('keeps the terminal running when its stop fails', async () => {
    const { closeTab, shutdownCompletedAgentPaneForHibernation, store } = createStore()
    shutdownCompletedAgentPaneForHibernation.mockRejectedValueOnce(new Error('kill failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ownership = own(store)

    expect(await ownership.finalize({ preservePane: true })).toBeNull()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('release consumes ownership without closing the terminal', async () => {
    const { closeTab, store } = createStore()
    const ownership = own(store)

    ownership.release()

    expect(await ownership.finalize({ preservePane: false })).toBeNull()
    expect(closeTab).not.toHaveBeenCalled()
  })
})
