import { describe, expect, it, vi } from 'vitest'

const { resolveCardInput } = vi.hoisted(() => ({
  resolveCardInput: vi.fn((_state: unknown, _args: unknown) => ({ localWindowsConpty: true }))
}))
vi.mock('@/components/dashboard/dashboard-card-terminal-input', () => ({
  resolveDashboardCardTerminalInput: resolveCardInput
}))
vi.mock('@/components/dashboard/dashboard-client-host', () => ({
  readDashboardClientHost: () => ({ platform: 'win32', userAgent: 'Windows', osRelease: '10.0' })
}))

import type { AppState } from '../types'
import { resolveDetachedTerminalInput } from './detached-terminal-input'

const leafId = '11111111-1111-4111-8111-111111111111'

function stateWith(tab: Record<string, unknown>, layout?: Record<string, unknown>): AppState {
  return {
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1', worktreeId: 'wt-1', ...tab }] },
    terminalLayoutsByTabId: layout ? { 'tab-1': layout } : {},
    allWorktrees: () => [{ id: 'wt-1', path: 'C:\\repo' }]
  } as unknown as AppState
}

describe('resolveDetachedTerminalInput', () => {
  it("resolves the detached PTY's pane like a dashboard card", () => {
    const state = stateWith(
      { shellOverride: 'pwsh', launchAgent: 'claude' },
      { activeLeafId: null, ptyIdsByLeafId: { [leafId]: 'pty-1' } }
    )

    expect(resolveDetachedTerminalInput(state, 'tab-1', 'pty-1')).toEqual({
      localWindowsConpty: true
    })
    expect(resolveCardInput).toHaveBeenCalledWith(state, {
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      paneKey: `tab-1:${leafId}`,
      cwd: 'C:\\repo',
      shellOverride: 'pwsh',
      launchAgent: 'claude',
      clientPlatform: 'win32',
      userAgent: 'Windows',
      osRelease: '10.0'
    })
  })

  it('prefers the startup cwd and tolerates a layout without a stable leaf', () => {
    resolveCardInput.mockClear()
    resolveDetachedTerminalInput(
      stateWith({ startupCwd: 'C:\\repo\\app' }, { activeLeafId: 'leaf-1', ptyIdsByLeafId: {} }),
      'tab-1',
      'pty-1'
    )

    expect(resolveCardInput.mock.calls[0][1]).toMatchObject({
      paneKey: 'tab-1',
      cwd: 'C:\\repo\\app'
    })
  })

  it('returns null once the tab is gone', () => {
    expect(resolveDetachedTerminalInput(stateWith({}), 'tab-gone', 'pty-1')).toBeNull()
  })
})
