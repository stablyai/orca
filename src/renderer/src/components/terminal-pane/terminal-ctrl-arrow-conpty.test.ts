import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  isLocalWindowsConptyPaneForCtrlArrow,
  type TerminalCtrlArrowConptyState
} from './terminal-ctrl-arrow-conpty'
import type { PtyTransport } from './pty-transport-types'

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

function state(
  overrides: Partial<TerminalCtrlArrowConptyState> = {}
): TerminalCtrlArrowConptyState {
  return {
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    settings: null,
    tabsByWorktree: {},
    ...overrides
  }
}

function localTransport(
  metadata: { cwd?: string; shellOverride?: string } = {}
): Pick<PtyTransport, 'getPtyId' | 'getConnectionId' | 'getLocalSessionMetadata'> {
  return {
    getPtyId: () => 'pty-1',
    getConnectionId: () => null,
    getLocalSessionMetadata: () => metadata
  }
}

function remoteRuntimeTransport(): Pick<
  PtyTransport,
  'getPtyId' | 'getConnectionId' | 'getLocalSessionMetadata'
> {
  return {
    getPtyId: () => 'remote:env-1@@terminal-1',
    getConnectionId: () => null,
    getLocalSessionMetadata: () => null
  }
}

describe('isLocalWindowsConptyPaneForCtrlArrow', () => {
  it('uses live local session metadata for synthetic floating terminals with no repo record', () => {
    expect(
      isLocalWindowsConptyPaneForCtrlArrow({
        isWindows: true,
        userAgent: WINDOWS_UA,
        state: state({
          tabsByWorktree: {
            [FLOATING_TERMINAL_WORKTREE_ID]: [{ id: 'tab-1', shellOverride: 'powershell.exe' }]
          }
        }),
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        tabId: 'tab-1',
        paneId: 1,
        paneCwd: new Map(),
        fallbackCwd: 'C:\\Users\\me',
        transport: localTransport({ cwd: 'C:\\Users\\me', shellOverride: 'powershell.exe' })
      })
    ).toBe(true)
  })

  it('keeps an already-launched local PowerShell pane local after store ownership changes', () => {
    const worktreeId = 'repo-1::C:\\repo'
    expect(
      isLocalWindowsConptyPaneForCtrlArrow({
        isWindows: true,
        userAgent: WINDOWS_UA,
        state: state({
          settings: { activeRuntimeEnvironmentId: 'env-1' },
          tabsByWorktree: {
            [worktreeId]: [{ id: 'tab-1', shellOverride: 'wsl.exe' }]
          }
        }),
        worktreeId,
        tabId: 'tab-1',
        paneId: 1,
        paneCwd: new Map([[1, { cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me', confirmed: true }]]),
        fallbackCwd: '\\\\wsl.localhost\\Ubuntu\\home\\me',
        transport: localTransport({ cwd: 'C:\\repo', shellOverride: 'powershell.exe' })
      })
    ).toBe(true)
  })

  it('does not treat a live remote-runtime terminal as local ConPTY', () => {
    expect(
      isLocalWindowsConptyPaneForCtrlArrow({
        isWindows: true,
        userAgent: WINDOWS_UA,
        state: state(),
        worktreeId: 'repo-1::/remote/repo',
        tabId: 'tab-1',
        paneId: 1,
        paneCwd: new Map([[1, { cwd: '/remote/repo', confirmed: true }]]),
        fallbackCwd: '/remote/repo',
        transport: remoteRuntimeTransport()
      })
    ).toBe(false)
  })

  it('stays conservative for unresolved repo-backed panes before a live session exists', () => {
    expect(
      isLocalWindowsConptyPaneForCtrlArrow({
        isWindows: true,
        userAgent: WINDOWS_UA,
        state: state(),
        worktreeId: 'missing-repo::/home/me/repo',
        tabId: 'tab-1',
        paneId: 1,
        paneCwd: new Map([[1, { cwd: '/home/me/repo', confirmed: true }]]),
        fallbackCwd: '/home/me/repo',
        transport: null
      })
    ).toBe(false)
  })
})
