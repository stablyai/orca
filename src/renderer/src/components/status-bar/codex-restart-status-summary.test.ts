import { describe, expect, it } from 'vitest'
import { summarizeCodexRestartStatus } from './codex-restart-status-summary'

describe('summarizeCodexRestartStatus', () => {
  it('does not scan tab maps when there are no stale Codex restart notices', () => {
    const throwingTabsByWorktree = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('tabsByWorktree should not be scanned')
        }
      }
    ) as Record<string, { id: string }[]>
    const throwingPtyIdsByTabId = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ptyIdsByTabId should not be scanned')
        }
      }
    ) as Record<string, string[]>

    expect(
      summarizeCodexRestartStatus({
        tabsByWorktree: throwingTabsByWorktree,
        ptyIdsByTabId: throwingPtyIdsByTabId,
        codexRestartNoticeByPtyId: {}
      })
    ).toEqual({
      stalePtyIds: [],
      staleSessionCount: 0,
      staleTabCount: 0,
      staleWorktreeCount: 0
    })
  })

  it('counts stale Codex sessions, tabs, and worktrees', () => {
    expect(
      summarizeCodexRestartStatus({
        tabsByWorktree: {
          wt1: [{ id: 'tab-1' }, { id: 'tab-2' }],
          wt2: [{ id: 'tab-3' }]
        },
        ptyIdsByTabId: {
          'tab-1': ['pty-1', 'pty-2'],
          'tab-2': ['pty-3'],
          'tab-3': ['pty-4']
        },
        codexRestartNoticeByPtyId: {
          'pty-1': { previousAccountLabel: 'a', nextAccountLabel: 'b' },
          'pty-2': { previousAccountLabel: 'a', nextAccountLabel: 'b' },
          'pty-4': { previousAccountLabel: 'a', nextAccountLabel: 'b' }
        }
      })
    ).toEqual({
      stalePtyIds: ['pty-1', 'pty-2', 'pty-4'],
      staleSessionCount: 3,
      staleTabCount: 2,
      staleWorktreeCount: 2
    })
  })
})
