// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { createTestStore, seedStore } from '@/store/slices/store-test-helpers'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  persist: vi.fn(),
  build: vi.fn(() => ({ session: true }))
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState, setState: mocks.setState } }))
vi.mock('@/lib/workspace-session', () => ({ buildWorkspaceSessionPayload: mocks.build }))
vi.mock('@/lib/workspace-session-host-persistence', () => ({
  persistWorkspaceSessionByHost: mocks.persist
}))
vi.mock('./pty-dispatcher', () => ({ ensurePtyDispatcher: vi.fn() }))

import { executeTerminalWindowTransferCommand } from './use-terminal-window-transfer'

function makeTerminalTab(): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('terminal window transfer persistence rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.persist.mockReset().mockResolvedValue(undefined)
    globalThis.window.api = { session: {} } as never
  })

  it.each(['target-remove', 'source-restore'] as const)(
    'keeps the renderer compensation applied when %s persistence fails',
    async (phase) => {
      const store = createTestStore()
      const terminal = makeTerminalTab()
      const applyCompensation = vi.fn(() => {
        store.setState({
          tabsByWorktree: { 'wt-1': phase === 'source-restore' ? [terminal] : [] }
        })
        return true
      })
      seedStore(store, {
        workspaceSessionReady: true,
        hydrationSucceeded: true,
        removeTransferredTerminalTab: applyCompensation,
        restoreTransferredTerminalTab: applyCompensation,
        tabsByWorktree: { 'wt-1': phase === 'target-remove' ? [terminal] : [] },
        unifiedTabsByWorktree: {},
        groupsByWorktree: {},
        openFiles: [],
        browserTabsByWorktree: {}
      })
      mocks.getState.mockImplementation(store.getState)
      mocks.setState.mockImplementation(store.setState)
      mocks.persist.mockRejectedValueOnce(new Error('persist failed'))

      await expect(
        executeTerminalWindowTransferCommand({
          transferId: `transfer-compensation-${phase}`,
          tabId: terminal.id,
          phase,
          ...(phase === 'source-restore' ? { seed: { tabId: terminal.id } } : {})
        } as never)
      ).rejects.toThrow('persist failed')

      expect(store.getState().tabsByWorktree['wt-1']).toEqual(
        phase === 'source-restore' ? [terminal] : []
      )
    }
  )

  it.each(['target-import', 'source-restore'] as const)(
    'keeps an idempotent %s replay intact when persistence fails',
    async (phase) => {
      const store = createTestStore()
      const terminal = makeTerminalTab()
      seedStore(store, {
        workspaceSessionReady: true,
        hydrationSucceeded: true,
        importTransferredTerminalTab: vi.fn(() => true),
        restoreTransferredTerminalTab: vi.fn(() => true),
        tabsByWorktree: { 'wt-1': [terminal] },
        unifiedTabsByWorktree: {},
        groupsByWorktree: {},
        openFiles: [],
        browserTabsByWorktree: {}
      })
      mocks.getState.mockImplementation(store.getState)
      mocks.setState.mockImplementation(store.setState)
      mocks.persist.mockRejectedValueOnce(new Error('persist failed'))

      await expect(
        executeTerminalWindowTransferCommand({
          transferId: `transfer-replay-${phase}`,
          tabId: terminal.id,
          phase,
          seed: { tabId: terminal.id }
        } as never)
      ).rejects.toThrow('persist failed')

      expect(store.getState().tabsByWorktree['wt-1']).toEqual([terminal])
    }
  )

  it('restores partial staged residuals after a failed target import', async () => {
    const store = createTestStore()
    const terminal = makeTerminalTab()
    const terminalTab = {
      id: terminal.id,
      entityId: terminal.id,
      contentType: 'terminal',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    }
    const stagedGroup = {
      id: 'group-1',
      worktreeId: 'wt-1',
      tabOrder: [],
      activeTabId: null,
      recentTabIds: []
    }
    const concurrentTab = {
      id: 'editor-concurrent',
      entityId: 'editor-concurrent',
      contentType: 'editor',
      worktreeId: 'wt-1',
      groupId: 'group-concurrent'
    }
    const concurrentGroup = {
      id: 'group-concurrent',
      worktreeId: 'wt-1',
      tabOrder: [concurrentTab.id],
      activeTabId: concurrentTab.id,
      recentTabIds: []
    }
    const importTransferredTerminalTab = vi.fn(() => {
      store.setState({
        tabsByWorktree: { 'wt-1': [terminal] },
        unifiedTabsByWorktree: { 'wt-1': [terminalTab] },
        groupsByWorktree: {
          'wt-1': [
            {
              ...stagedGroup,
              tabOrder: [terminal.id],
              activeTabId: terminal.id,
              recentTabIds: [terminal.id]
            }
          ]
        }
      } as never)
      return true
    })
    seedStore(store, {
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      importTransferredTerminalTab,
      tabsByWorktree: { 'wt-1': [] },
      unifiedTabsByWorktree: { 'wt-1': [] },
      groupsByWorktree: { 'wt-1': [stagedGroup] },
      layoutByWorktree: { 'wt-1': { type: 'leaf', groupId: stagedGroup.id } },
      tabBarOrderByWorktree: { 'wt-1': [terminal.id] },
      openFiles: [],
      browserTabsByWorktree: {}
    })
    mocks.getState.mockImplementation(store.getState)
    mocks.setState.mockImplementation(store.setState)
    mocks.persist.mockImplementationOnce(async () => {
      const importedLayout = store.getState().layoutByWorktree['wt-1']!
      store.setState({
        unifiedTabsByWorktree: { 'wt-1': [terminalTab, concurrentTab] },
        groupsByWorktree: {
          'wt-1': [store.getState().groupsByWorktree['wt-1'][0], concurrentGroup]
        },
        layoutByWorktree: {
          'wt-1': {
            type: 'split',
            direction: 'horizontal',
            first: importedLayout,
            second: { type: 'leaf', groupId: concurrentGroup.id }
          }
        },
        tabBarOrderByWorktree: { 'wt-1': [terminal.id, concurrentTab.id] }
      } as never)
      throw new Error('persist failed')
    })

    await expect(
      executeTerminalWindowTransferCommand({
        transferId: 'transfer-partial-import',
        tabId: terminal.id,
        phase: 'target-import',
        seed: { tabId: terminal.id }
      } as never)
    ).rejects.toThrow('persist failed')

    const state = store.getState()
    expect(state.tabsByWorktree['wt-1']).toEqual([])
    expect(state.unifiedTabsByWorktree['wt-1']).toEqual([concurrentTab])
    expect(state.groupsByWorktree['wt-1']).toEqual([stagedGroup, concurrentGroup])
    expect(state.tabBarOrderByWorktree['wt-1']).toEqual([terminal.id, concurrentTab.id])
    expect(state.layoutByWorktree['wt-1']).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: stagedGroup.id },
      second: { type: 'leaf', groupId: concurrentGroup.id }
    })
  })
})
