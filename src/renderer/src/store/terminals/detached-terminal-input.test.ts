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

import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  resolveDetachedTerminalInput,
  type DetachedTerminalInputState
} from './detached-terminal-input'

const leafId = '11111111-1111-4111-8111-111111111111'

function stateWith(
  tab: Partial<TerminalTab>,
  layout?: Pick<TerminalLayoutSnapshot, 'activeLeafId' | 'ptyIdsByLeafId'>
): DetachedTerminalInputState {
  const terminalTab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...tab
  }
  return {
    tabsByWorktree: { 'wt-1': [terminalTab] },
    terminalLayoutsByTabId: layout
      ? { 'tab-1': { root: null, expandedLeafId: null, ...layout } }
      : {},
    allWorktrees: () => [{ id: 'wt-1', path: 'C:\\repo' }]
  }
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
