// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  persist: vi.fn().mockResolvedValue(undefined),
  build: vi.fn(() => ({ session: true }))
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState, setState: mocks.setState, subscribe: mocks.subscribe }
}))
vi.mock('@/lib/workspace-session', () => ({ buildWorkspaceSessionPayload: mocks.build }))
vi.mock('@/lib/workspace-session-host-persistence', () => ({
  persistWorkspaceSessionByHost: mocks.persist
}))
vi.mock('./pty-dispatcher', () => ({ ensurePtyDispatcher: vi.fn() }))

import {
  executeTerminalWindowTransferCommand,
  useTerminalWindowTransfer
} from './use-terminal-window-transfer'

describe('executeTerminalWindowTransferCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.window.api = { session: {} } as never
  })

  it('imports, durably persists, and acknowledges a transferred terminal', async () => {
    const importTransferredTerminalTab = vi.fn(() => true)
    const state = {
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      importTransferredTerminalTab,
      removeTransferredTerminalTab: vi.fn(() => true),
      unifiedTabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] }
    }
    mocks.getState.mockReturnValue(state)
    const seed = {
      tabId: 'tab-1',
      hostId: 'local',
      canonicalWorkspaceKey: 'worktree:wt-1',
      worktreeId: 'wt-1',
      repo: { id: 'repo-1' },
      group: { id: 'group-1' },
      tab: { id: 'tab-1' },
      layout: {},
      ptyIds: ['pty-1']
    } as never

    await expect(
      executeTerminalWindowTransferCommand({
        transferId: 'transfer-1',
        tabId: 'tab-1',
        phase: 'target-import',
        seed
      })
    ).resolves.toEqual({
      transferId: 'transfer-1',
      tabId: 'tab-1',
      phase: 'target-import',
      ok: true,
      empty: false
    })
    expect(importTransferredTerminalTab).toHaveBeenCalledWith(seed)
    expect(mocks.persist).toHaveBeenCalledOnce()
  })

  it.each([
    ['unified terminal', { unifiedTabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] } }],
    ['legacy terminal', { tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] } }],
    ['editor', { openFiles: [{ id: 'file-1' }] }],
    ['browser', { browserTabsByWorktree: { 'wt-1': [{ id: 'browser-1' }] } }]
  ])('reports a window with %s backing as nonempty', async (_label, backing) => {
    mocks.getState.mockReturnValue({
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      importTransferredTerminalTab: vi.fn(() => true),
      restoreTransferredTerminalTab: vi.fn(() => true),
      removeTransferredTerminalTab: vi.fn(() => true),
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {},
      ...backing
    })

    await expect(
      executeTerminalWindowTransferCommand({
        transferId: 'transfer-empty',
        tabId: 'removed-tab',
        phase: 'target-remove'
      })
    ).resolves.toMatchObject({ empty: false })
  })

  it('copies the transfer ID into rejected command ACKs', async () => {
    const ack = vi.fn()
    let onCommand!: (command: never) => void
    globalThis.window.api = {
      session: {},
      terminalWindow: {
        ack,
        detach: vi.fn(),
        getContext: vi.fn().mockResolvedValue({
          windowId: 1,
          role: 'control',
          transitionFenced: false
        }),
        onCommand: vi.fn((callback) => {
          onCommand = callback
          return vi.fn()
        })
      }
    } as never
    mocks.getState.mockReturnValue({ workspaceSessionReady: true, hydrationSucceeded: true })

    renderHook(() => useTerminalWindowTransfer())
    onCommand({
      transferId: 'transfer-rejected',
      tabId: 'tab-1',
      phase: 'target-import'
    } as never)

    await waitFor(() =>
      expect(ack).toHaveBeenCalledWith({
        transferId: 'transfer-rejected',
        tabId: 'tab-1',
        phase: 'target-import',
        ok: false,
        error: 'terminal_transfer_seed_missing'
      })
    )
  })

  it('advertises command readiness only after workspace hydration', async () => {
    let state = { workspaceSessionReady: false, hydrationSucceeded: false }
    let onStoreChange!: () => void
    const getContext = vi.fn().mockResolvedValue({
      windowId: 1,
      role: 'control',
      transitionFenced: false
    })
    globalThis.window.api = {
      session: {},
      terminalWindow: {
        ack: vi.fn(),
        detach: vi.fn(),
        getContext,
        onCommand: vi.fn(() => vi.fn())
      }
    } as never
    mocks.getState.mockImplementation(() => state)
    mocks.subscribe.mockImplementation((listener) => {
      onStoreChange = listener
      return vi.fn()
    })

    renderHook(() => useTerminalWindowTransfer())
    await Promise.resolve()
    expect(getContext).not.toHaveBeenCalled()

    state = { workspaceSessionReady: true, hydrationSucceeded: true }
    onStoreChange()
    await waitFor(() => expect(getContext).toHaveBeenCalledOnce())
    onStoreChange()
    expect(getContext).toHaveBeenCalledOnce()
  })

  it('cancels deferred context readiness when unmounted before hydration', async () => {
    let state = { workspaceSessionReady: false, hydrationSucceeded: false }
    let onStoreChange!: () => void
    const unsubscribeStore = vi.fn()
    const unsubscribeCommand = vi.fn()
    const getContext = vi.fn()
    globalThis.window.api = {
      session: {},
      terminalWindow: {
        ack: vi.fn(),
        detach: vi.fn(),
        getContext,
        onCommand: vi.fn(() => unsubscribeCommand)
      }
    } as never
    mocks.getState.mockImplementation(() => state)
    mocks.subscribe.mockImplementation((listener) => {
      onStoreChange = listener
      return unsubscribeStore
    })

    const hook = renderHook(() => useTerminalWindowTransfer())
    hook.unmount()
    state = { workspaceSessionReady: true, hydrationSucceeded: true }
    onStoreChange()
    await Promise.resolve()

    expect(getContext).not.toHaveBeenCalled()
    expect(unsubscribeStore).toHaveBeenCalledOnce()
    expect(unsubscribeCommand).toHaveBeenCalledOnce()
  })

  it('routes restore separately from target import and persists fresh state', async () => {
    const importTransferredTerminalTab = vi.fn(() => true)
    const restoreTransferredTerminalTab = vi.fn(() => true)
    const removeTransferredTerminalTab = vi.fn(() => true)
    const initial = {
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      importTransferredTerminalTab,
      restoreTransferredTerminalTab,
      removeTransferredTerminalTab,
      unifiedTabsByWorktree: {}
    }
    const fresh = { ...initial, unifiedTabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] } }
    mocks.getState.mockReturnValueOnce(initial).mockReturnValue(fresh)
    const seed = { tabId: 'tab-1' } as never

    await executeTerminalWindowTransferCommand({
      transferId: 'transfer-restore',
      tabId: 'tab-1',
      phase: 'source-restore',
      seed
    })

    expect(restoreTransferredTerminalTab).toHaveBeenCalledWith(seed)
    expect(importTransferredTerminalTab).not.toHaveBeenCalled()
    expect(mocks.build).toHaveBeenCalledWith(fresh)
    expect(mocks.persist).toHaveBeenCalledWith({}, { session: true }, fresh)
  })

  it('waits for durable persistence before sending a success ACK', async () => {
    let resolvePersist!: () => void
    mocks.persist.mockReturnValueOnce(new Promise<void>((resolve) => (resolvePersist = resolve)))
    const ack = vi.fn()
    let onCommand!: (command: never) => void
    const unsubscribe = vi.fn()
    globalThis.window.api = {
      session: {},
      terminalWindow: {
        ack,
        detach: vi.fn(),
        getContext: vi.fn().mockResolvedValue({
          windowId: 1,
          role: 'control',
          transitionFenced: false
        }),
        onCommand: vi.fn((callback) => {
          onCommand = callback
          return unsubscribe
        })
      }
    } as never
    const state = {
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      importTransferredTerminalTab: vi.fn(() => true),
      restoreTransferredTerminalTab: vi.fn(() => true),
      removeTransferredTerminalTab: vi.fn(() => true),
      unifiedTabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] }
    }
    mocks.getState.mockReturnValue(state)

    const hook = renderHook(() => useTerminalWindowTransfer())
    onCommand({
      transferId: 'transfer-durable',
      tabId: 'tab-1',
      phase: 'target-import',
      seed: { tabId: 'tab-1' }
    } as never)
    await Promise.resolve()
    expect(ack).not.toHaveBeenCalled()

    resolvePersist()
    await waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true })))
    hook.rerender()
    expect(globalThis.window.api.terminalWindow.onCommand).toHaveBeenCalledOnce()
    hook.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('rolls back an import exactly when durable flush rejects, then accepts its inverse', async () => {
    const beforeFields = {
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      lastKnownRelayPtyIdByTabId: {}
    }
    let state: Record<string, unknown>
    const actions = {
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      importTransferredTerminalTab: vi.fn(() => {
        state = {
          ...state,
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
          unifiedTabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
          groupsByWorktree: { 'wt-1': [{ id: 'group-1', tabOrder: ['tab-1'] }] },
          terminalLayoutsByTabId: { 'tab-1': { root: null } },
          ptyIdsByTabId: { 'tab-1': ['pty-1'] },
          lastKnownRelayPtyIdByTabId: { 'tab-1': 'pty-1' }
        }
        return true
      }),
      restoreTransferredTerminalTab: vi.fn(() => true),
      removeTransferredTerminalTab: vi.fn(() => true)
    }
    state = { ...actions, ...beforeFields, openFiles: [], browserTabsByWorktree: {} }
    mocks.getState.mockImplementation(() => state)
    mocks.setState.mockImplementation((updater) => {
      const patch = typeof updater === 'function' ? updater(state) : updater
      state = { ...state, ...patch }
    })
    mocks.persist.mockRejectedValueOnce(new Error('flush failed')).mockResolvedValueOnce(undefined)
    const seed = { tabId: 'tab-1' } as never

    await expect(
      executeTerminalWindowTransferCommand({
        transferId: 'transfer-compensate',
        tabId: 'tab-1',
        phase: 'target-import',
        seed
      })
    ).rejects.toThrow('flush failed')
    for (const [field, value] of Object.entries(beforeFields)) {
      expect(state[field]).toBe(value)
    }

    await executeTerminalWindowTransferCommand({
      transferId: 'transfer-compensate',
      tabId: 'tab-1',
      phase: 'target-remove'
    })
    expect(actions.removeTransferredTerminalTab).toHaveBeenCalledOnce()
    expect(mocks.persist).toHaveBeenCalledTimes(2)
  })

  it('rolls back every source removal projection when durable set rejects', async () => {
    const beforeFields = {
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
      unifiedTabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
      groupsByWorktree: { 'wt-1': [{ id: 'group-1', tabOrder: ['tab-1'] }] },
      layoutByWorktree: { 'wt-1': { type: 'leaf', groupId: 'group-1' } },
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      activeTabIdByWorktree: { 'wt-1': 'tab-1' },
      activeTabTypeByWorktree: { 'wt-1': 'terminal' },
      activeTabId: 'tab-1',
      activeTabType: 'terminal',
      agentStatusByPaneKey: { 'tab-1:leaf-1': { state: 'working' } },
      runtimeAgentOrchestrationByPaneKey: { 'tab-1:leaf-1': { dispatchStatus: 'running' } },
      retainedAgentsByPaneKey: { 'tab-1:leaf-1': { state: 'done' } },
      sleepingAgentSessionsByPaneKey: { 'tab-1:leaf-1': { state: 'working' } },
      agentLaunchConfigByPaneKey: { 'tab-1:leaf-1': { registeredAt: 1 } },
      acknowledgedAgentsByPaneKey: { 'tab-1:leaf-1': 1 },
      paneForegroundAgentByPaneKey: { 'tab-1:leaf-1': { agent: 'claude' } },
      retentionSuppressedPaneKeys: { 'tab-1:leaf-1': true },
      unreadTerminalPanes: { 'tab-1:leaf-1': true },
      unreadAgentCompletionPanes: { 'tab-1:leaf-1': true },
      lastTerminalInputAtByPaneKey: { 'tab-1:leaf-1': 1 },
      cacheTimerByKey: { 'tab-1:leaf-1': 1 },
      migrationUnsupportedByPtyId: { 'pty-1': { paneKey: 'tab-1:leaf-1' } },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: { 'tab-1': { root: null } },
      lastKnownRelayPtyIdByTabId: { 'tab-1': 'pty-1' },
      directSshPaneRetryByTabId: { 'tab-1': { attemptId: 'attempt-1' } },
      directSshLivePtyBindingByTabId: { 'tab-1': { ptyId: 'pty-1' } },
      directSshPaneRetryHistoryByTabId: { 'tab-1': { attemptedAt: [1] } }
    }
    let state: Record<string, unknown>
    const actions = {
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      importTransferredTerminalTab: vi.fn(() => true),
      restoreTransferredTerminalTab: vi.fn(() => true),
      removeTransferredTerminalTab: vi.fn(() => {
        state = {
          ...state,
          tabsByWorktree: { 'wt-1': [] },
          unifiedTabsByWorktree: { 'wt-1': [] },
          groupsByWorktree: {},
          layoutByWorktree: {},
          activeGroupIdByWorktree: {},
          activeTabIdByWorktree: { 'wt-1': null },
          activeTabTypeByWorktree: { 'wt-1': 'editor' },
          activeTabId: null,
          activeTabType: 'editor',
          agentStatusByPaneKey: {},
          runtimeAgentOrchestrationByPaneKey: {},
          retainedAgentsByPaneKey: {},
          sleepingAgentSessionsByPaneKey: {},
          agentLaunchConfigByPaneKey: {},
          acknowledgedAgentsByPaneKey: {},
          paneForegroundAgentByPaneKey: {},
          retentionSuppressedPaneKeys: {},
          unreadTerminalPanes: {},
          unreadAgentCompletionPanes: {},
          lastTerminalInputAtByPaneKey: {},
          cacheTimerByKey: {},
          migrationUnsupportedByPtyId: {},
          ptyIdsByTabId: {},
          terminalLayoutsByTabId: {},
          lastKnownRelayPtyIdByTabId: {},
          directSshPaneRetryByTabId: {},
          directSshLivePtyBindingByTabId: {},
          directSshPaneRetryHistoryByTabId: {}
        }
        return true
      })
    }
    state = { ...actions, ...beforeFields, openFiles: [], browserTabsByWorktree: {} }
    mocks.getState.mockImplementation(() => state)
    mocks.setState.mockImplementation((updater) => {
      const patch = typeof updater === 'function' ? updater(state) : updater
      state = { ...state, ...patch }
    })
    mocks.persist.mockRejectedValueOnce(new Error('set failed')).mockResolvedValueOnce(undefined)

    await expect(
      executeTerminalWindowTransferCommand({
        transferId: 'transfer-source-compensate',
        tabId: 'tab-1',
        phase: 'source-remove'
      })
    ).rejects.toThrow('set failed')
    for (const [field, value] of Object.entries(beforeFields)) {
      expect(state[field]).toBe(value)
    }

    await executeTerminalWindowTransferCommand({
      transferId: 'transfer-source-compensate',
      tabId: 'tab-1',
      phase: 'source-restore',
      seed: { tabId: 'tab-1' } as never
    })
    expect(actions.restoreTransferredTerminalTab).toHaveBeenCalledOnce()
    expect(mocks.persist).toHaveBeenCalledTimes(2)
  })

  it('does not roll back a transfer field changed concurrently after the action', async () => {
    const beforeTabs = {}
    const afterTabs = { 'wt-1': [{ id: 'tab-1' }] }
    const concurrentTabs = { 'wt-1': [{ id: 'tab-concurrent' }] }
    let state: Record<string, unknown>
    const importTransferredTerminalTab = vi.fn(() => {
      state = { ...state, tabsByWorktree: afterTabs }
      return true
    })
    state = {
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      importTransferredTerminalTab,
      restoreTransferredTerminalTab: vi.fn(() => true),
      removeTransferredTerminalTab: vi.fn(() => true),
      tabsByWorktree: beforeTabs,
      unifiedTabsByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {}
    }
    mocks.getState.mockImplementation(() => state)
    mocks.setState.mockImplementation((updater) => {
      const patch = typeof updater === 'function' ? updater(state) : updater
      state = { ...state, ...patch }
    })
    mocks.persist.mockImplementationOnce(async () => {
      state = { ...state, tabsByWorktree: concurrentTabs }
      throw new Error('disk full')
    })

    await expect(
      executeTerminalWindowTransferCommand({
        transferId: 'transfer-concurrent',
        tabId: 'tab-1',
        phase: 'target-import',
        seed: { tabId: 'tab-1' } as never
      })
    ).rejects.toThrow('disk full')

    expect(state.tabsByWorktree).toBe(concurrentTabs)
  })
})
