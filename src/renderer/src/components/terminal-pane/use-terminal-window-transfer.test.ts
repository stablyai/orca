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

import { executeTerminalWindowTransferCommand } from './use-terminal-window-transfer'

describe('executeTerminalWindowTransferCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.window = { api: { session: {} } } as never
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
        tabId: 'tab-1',
        phase: 'target-import',
        seed
      })
    ).resolves.toEqual({
      tabId: 'tab-1',
      phase: 'target-import',
      ok: true,
      empty: false
    })
    expect(importTransferredTerminalTab).toHaveBeenCalledWith(seed)
    expect(mocks.persist).toHaveBeenCalledOnce()
  })
})
