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
})
