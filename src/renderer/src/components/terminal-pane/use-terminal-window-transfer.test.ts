// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  subscribe: vi.fn(),
  persist: vi.fn().mockResolvedValue(undefined),
  build: vi.fn(() => ({ session: true }))
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState, subscribe: mocks.subscribe }
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

  it('leaves failed persistence compensable by the inverse command', async () => {
    let imported = false
    const state = {
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      importTransferredTerminalTab: vi.fn(() => {
        imported = true
        return true
      }),
      restoreTransferredTerminalTab: vi.fn(() => {
        imported = true
        return true
      }),
      removeTransferredTerminalTab: vi.fn(() => {
        imported = false
        return true
      }),
      unifiedTabsByWorktree: {}
    }
    mocks.getState.mockReturnValue(state)
    mocks.persist.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined)
    const seed = { tabId: 'tab-1' } as never

    await expect(
      executeTerminalWindowTransferCommand({
        transferId: 'transfer-compensate',
        tabId: 'tab-1',
        phase: 'target-import',
        seed
      })
    ).rejects.toThrow('disk full')
    expect(imported).toBe(true)

    await executeTerminalWindowTransferCommand({
      transferId: 'transfer-compensate',
      tabId: 'tab-1',
      phase: 'target-remove'
    })
    expect(imported).toBe(false)
  })

  it('restores a source after its remove persistence fails', async () => {
    let present = true
    const state = {
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      importTransferredTerminalTab: vi.fn(() => true),
      restoreTransferredTerminalTab: vi.fn(() => {
        present = true
        return true
      }),
      removeTransferredTerminalTab: vi.fn(() => {
        present = false
        return true
      }),
      unifiedTabsByWorktree: {}
    }
    mocks.getState.mockReturnValue(state)
    mocks.persist.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined)

    await expect(
      executeTerminalWindowTransferCommand({
        transferId: 'transfer-source-compensate',
        tabId: 'tab-1',
        phase: 'source-remove'
      })
    ).rejects.toThrow('disk full')
    expect(present).toBe(false)

    await executeTerminalWindowTransferCommand({
      transferId: 'transfer-source-compensate',
      tabId: 'tab-1',
      phase: 'source-restore',
      seed: { tabId: 'tab-1' } as never
    })
    expect(present).toBe(true)
  })
})
