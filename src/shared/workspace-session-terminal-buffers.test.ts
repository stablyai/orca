import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import type { WorkspaceSessionState } from './types'
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
        ptyIdsByLeafId: { 'pane:1': 'local-pty' }
      },
      'remote-tab': {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        buffersByLeafId: { 'pane:1': 'remote-scrollback' },
        ptyIdsByLeafId: { 'pane:1': 'remote-pty' }
      }
    },
    ...overrides
  }
}

describe('pruneLocalTerminalScrollbackBuffers', () => {
  it('classifies which worktrees need renderer-captured scrollback', () => {
    const repos = [
      { id: 'local-repo', connectionId: null },
      { id: 'remote-repo', connectionId: 'ssh-target-1' }
    ]

    expect(shouldPreserveTerminalScrollbackBuffers('local-repo::/local/worktree', repos)).toBe(
      false
    )
    expect(shouldPreserveTerminalScrollbackBuffers('remote-repo::/remote/worktree', repos)).toBe(
      true
    )
    expect(shouldPreserveTerminalScrollbackBuffers(FLOATING_TERMINAL_WORKTREE_ID, repos)).toBe(
      false
    )
    expect(
      shouldPreserveTerminalScrollbackBuffers('unknown-repo::/maybe-remote/worktree', repos)
    ).toBe(true)
  })

  it('drops local buffers while preserving SSH buffers and PTY bindings', () => {
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

  it('treats orphaned layouts as local and prunes their buffers', () => {
    const result = pruneLocalTerminalScrollbackBuffers(
      makeSession({
        terminalLayoutsByTabId: {
          'orphan-tab': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            buffersByLeafId: { 'pane:1': 'orphan-scrollback' }
          }
        }
      }),
      [{ id: 'remote-repo', connectionId: 'ssh-target-1' }]
    )

    expect(result.terminalLayoutsByTabId['orphan-tab'].buffersByLeafId).toBeUndefined()
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

  it('keeps persisted session size from scaling with local scrollback buffers', () => {
    const largeScrollback = 'x'.repeat(8 * 1024)
    const tabs = Array.from({ length: 8 }, (_, index) => ({
      id: `local-tab-${index}`,
      title: `local ${index}`,
      customTitle: null,
      color: null,
      sortOrder: index,
      createdAt: index,
      ptyId: `local-pty-${index}`,
      worktreeId: 'local-repo::/local/worktree'
    }))
    const session = makeSession({
      tabsByWorktree: {
        'local-repo::/local/worktree': tabs
      },
      terminalLayoutsByTabId: Object.fromEntries(
        tabs.map((tab, index) => [
          tab.id,
          {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            buffersByLeafId: { 'pane:1': `${largeScrollback}-${index}` },
            ptyIdsByLeafId: { 'pane:1': tab.ptyId ?? '' }
          }
        ])
      )
    })

    const originalBytes = Buffer.byteLength(JSON.stringify(session))
    const result = pruneLocalTerminalScrollbackBuffers(session, [
      { id: 'local-repo', connectionId: null }
    ])
    const prunedBytes = Buffer.byteLength(JSON.stringify(result))

    expect(JSON.stringify(result)).not.toContain(largeScrollback)
    expect(prunedBytes).toBeLessThan(originalBytes / 5)
  })
})
