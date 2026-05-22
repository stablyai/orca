import { describe, expect, it, vi } from 'vitest'
import { collectStaleWorktreePtyIds, dismissStaleWorktreePtyIds } from './CodexRestartChip'

describe('CodexRestartChip helpers', () => {
  it('collects all stale PTY ids for tabs in a worktree', () => {
    expect(
      collectStaleWorktreePtyIds({
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
          'pty-3': { previousAccountLabel: 'a', nextAccountLabel: 'b' },
          'pty-4': { previousAccountLabel: 'a', nextAccountLabel: 'b' }
        },
        worktreeId: 'wt1'
      })
    ).toEqual(['pty-1', 'pty-3'])
  })

  it('returns an empty list when a worktree has no stale PTYs', () => {
    expect(
      collectStaleWorktreePtyIds({
        tabsByWorktree: {
          wt1: [{ id: 'tab-1' }]
        },
        ptyIdsByTabId: {
          'tab-1': ['pty-1']
        },
        codexRestartNoticeByPtyId: {},
        worktreeId: 'wt1'
      })
    ).toEqual([])
  })

  it('dismisses every stale PTY notice in the worktree prompt', () => {
    const clearCodexRestartNotice = vi.fn()

    dismissStaleWorktreePtyIds(['pty-1', 'pty-3'], clearCodexRestartNotice)

    expect(clearCodexRestartNotice).toHaveBeenNthCalledWith(1, 'pty-1')
    expect(clearCodexRestartNotice).toHaveBeenNthCalledWith(2, 'pty-3')
    expect(clearCodexRestartNotice).toHaveBeenCalledTimes(2)
  })
})
