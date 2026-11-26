import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../workspace/identity/floating-workspace-id'
import { getDefaultWorkspaceSession } from '../orca-profiles/constants'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import '../terminal/replay/terminal-scrollback-limits'

import {
  pruneLocalTerminalScrollbackBuffers,
  shouldPreserveTerminalScrollbackBuffers
} from './workspace-session-terminal-buffers'

function makeSession(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {
      'local-repo::/local/worktree': [
        {
          id: 'local-tab',
          title: 'local',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId: 'local-pty',
          worktreeId: 'local-repo::/local/worktree'
        }
      ],
      'remote-repo::/remote/worktree': [
        {
          id: 'remote-tab',
          title: 'remote',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId: 'remote-pty',
          worktreeId: 'remote-repo::/remote/worktree'
        }
      ]
    },
    terminalLayoutsByTabId: {
      'local-tab': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        buffersByLeafId: { 'pane:1': 'local-scrollback' },
        scrollbackRefsByLeafId: { 'pane:1': 'v1-local' },
        ptyIdsByLeafId: { 'pane:1': 'local-pty' }
      },
      'remote-tab': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        buffersByLeafId: { 'pane:1': 'remote-scrollback' },
        scrollbackRefsByLeafId: { 'pane:1': 'v1-remote' },
        ptyIdsByLeafId: { 'pane:1': 'remote-pty' }
      }
    },
    ...overrides
  }
}

function makeRuntimeSession(): WorkspaceSessionState {
  return makeSession({
    tabsByWorktree: {
      'runtime-repo::/runtime/worktree': [
        {
          id: 'runtime-tab',
          title: 'runtime',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId: 'runtime-pty',
          worktreeId: 'runtime-repo::/runtime/worktree'
        }
      ]
    },
    terminalLayoutsByTabId: {
      'runtime-tab': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        buffersByLeafId: { 'pane:1': 'runtime-scrollback' },
        scrollbackRefsByLeafId: { 'pane:1': 'v1-runtime' },
        ptyIdsByLeafId: { 'pane:1': 'runtime-pty' }
      }
    }
  })
}

describe('pruneLocalTerminalScrollbackBuffers', () => {
  it('preserves runtime-host scrollback without requiring an SSH connection ID', () => {
    expect(
      shouldPreserveTerminalScrollbackBuffers('runtime-repo::/runtime/worktree', [
        {
          id: 'runtime-repo',
          connectionId: null,
          executionHostId: 'runtime:env-1'
        }
      ])
    ).toBe(true)

    const result = pruneLocalTerminalScrollbackBuffers(makeRuntimeSession(), [
      {
        id: 'runtime-repo',
        connectionId: null,
        executionHostId: 'runtime:env-1'
      }
    ])

    expect(result.terminalLayoutsByTabId['runtime-tab'].buffersByLeafId).toEqual({
      'pane:1': 'runtime-scrollback'
    })
    expect(result.terminalLayoutsByTabId['runtime-tab'].scrollbackRefsByLeafId).toEqual({
      'pane:1': 'v1-runtime'
    })
  })

  it('keeps a dormant tab buffer, which has no live PTY to replay from', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        'local-repo::/w': [
          {
            id: 'dormant-tab',
            ptyId: null,
            worktreeId: 'local-repo::/w',
            title: 'Shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'dormant-tab': {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          buffersByLeafId: { 'pane:1': 'dormant output' }
        }
      }
    }
    const result = pruneLocalTerminalScrollbackBuffers(session, [
      { id: 'local-repo', connectionId: null }
    ])
    expect(result.terminalLayoutsByTabId['dormant-tab'].buffersByLeafId).toEqual({
      'pane:1': 'dormant output'
    })
  })

  it('drops scrollback for explicitly local execution hosts', () => {
    const result = pruneLocalTerminalScrollbackBuffers(makeRuntimeSession(), [
      {
        id: 'runtime-repo',
        connectionId: null,
        executionHostId: 'local'
      }
    ])

    expect(result.terminalLayoutsByTabId['runtime-tab']).toEqual({
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { 'pane:1': 'runtime-pty' }
    })
  })

  it('drops local scrollback while preserving SSH scrollback and PTY bindings', () => {
    const result = pruneLocalTerminalScrollbackBuffers(makeSession(), [
      { id: 'local-repo', connectionId: null },
      { id: 'remote-repo', connectionId: 'ssh-target-1' }
    ])

    expect(result.terminalLayoutsByTabId['local-tab']).toEqual({
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { 'pane:1': 'local-pty' }
    })
    expect(result.terminalLayoutsByTabId['remote-tab'].buffersByLeafId).toEqual({
      'pane:1': 'remote-scrollback'
    })
    expect(result.terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId).toEqual({
      'pane:1': 'v1-remote'
    })
  })

  it('drops floating terminal buffers even though the synthetic worktree has no repo', () => {
    const result = pruneLocalTerminalScrollbackBuffers(
      makeSession({
        tabsByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            {
              id: 'floating-tab',
              title: 'floating',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'floating-pty',
              worktreeId: FLOATING_TERMINAL_WORKTREE_ID
            }
          ]
        },
        terminalLayoutsByTabId: {
          'floating-tab': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            buffersByLeafId: { 'pane:1': 'floating-scrollback' },
            ptyIdsByLeafId: { 'pane:1': 'floating-pty' }
          }
        }
      }),
      []
    )

    expect(result.terminalLayoutsByTabId['floating-tab']).toEqual({
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { 'pane:1': 'floating-pty' }
    })
  })

  it('preserves buffers for unresolved repo catalogs until worktrees can be classified', () => {
    const result = pruneLocalTerminalScrollbackBuffers(
      makeSession({
        tabsByWorktree: {
          'remote-repo::/remote/worktree': [
            {
              id: 'remote-tab',
              title: 'remote',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'remote-pty',
              worktreeId: 'remote-repo::/remote/worktree'
            }
          ]
        },
        terminalLayoutsByTabId: {
          'remote-tab': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            buffersByLeafId: { 'pane:1': 'maybe-remote-scrollback' }
          }
        }
      }),
      []
    )

    expect(result.terminalLayoutsByTabId['remote-tab'].buffersByLeafId).toEqual({
      'pane:1': 'maybe-remote-scrollback'
    })
  })

  // Exercise every persisted home independently; silently omitting one defeats the cap.
})
