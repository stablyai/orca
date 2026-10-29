// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getRuntimeGitHistoryMock = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitHistory: getRuntimeGitHistoryMock
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))

import { useSourceControlGitHistory } from './use-git-history'

afterEach(cleanup)

// E9: showing Commits (or its Refresh) is a user act; a refresh after a Git action is not.
describe('Commits history and a stopped WSL distro', () => {
  it('wakes for the read that shows Commits, not for a later ref-driven refresh', async () => {
    getRuntimeGitHistoryMock.mockReset().mockResolvedValue({ items: [] })
    const { result } = renderHook(() =>
      useSourceControlGitHistory({
        activeRepoTarget: { kind: 'local' },
        activeWorktreeId: 'wt-1',
        worktreePath: '\\\\wsl.localhost\\Ubuntu\\repo',
        compareBaseRef: 'main',
        isFolder: false,
        isBranchVisible: true,
        isGitHistoryExpanded: true,
        isGitHistoryVisible: true,
        worktreeMap: new Map([['wt-1', {}]])
      })
    )
    await act(async () => {})
    await act(async () => result.current.refreshGitHistoryRef.current())
    await act(async () => result.current.refreshGitHistory({ wakeWslDistro: true }))

    expect(getRuntimeGitHistoryMock.mock.calls.map((call) => call[1].wakeWslDistro)).toEqual([
      true,
      undefined,
      true
    ])
  })
})
