// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { getRuntimeGitIgnoredPaths } from '@/runtime/source-control/git/runtime-git-status-client'
import { useFileExplorerIgnoredPaths } from './use-file-explorer-ignored-paths'

vi.mock('@/runtime/source-control/git/runtime-git-status-client', () => ({
  getRuntimeGitIgnoredPaths: vi.fn()
}))
vi.mock('../../source-control/sync/worktree-git-owner-target', () => ({
  getWorktreeGitOwnerTarget: () => ({ kind: 'local' })
}))

const RELATIVE_PATHS = ['dist', 'src']

function workspace(id: string): Parameters<typeof useFileExplorerIgnoredPaths>[0] {
  return {
    activeWorktreeId: id,
    canLoadIgnoredPaths: true,
    relativePaths: RELATIVE_PATHS,
    shouldDebounceIgnoredQuery: false,
    worktreePath: `/repo/${id}`
  }
}

describe('useFileExplorerIgnoredPaths across workspace switches', () => {
  it("shows the returned-to workspace's last answer while git rechecks it", async () => {
    const gitIgnored = vi.mocked(getRuntimeGitIgnoredPaths)
    gitIgnored.mockResolvedValueOnce(['dist']).mockResolvedValueOnce(['build'])
    const { result, rerender } = renderHook((props) => useFileExplorerIgnoredPaths(props), {
      initialProps: workspace('a')
    })
    await act(async () => {})
    expect(result.current).toEqual(['dist'])

    rerender(workspace('b'))
    await act(async () => {})
    expect(result.current).toEqual(['build'])

    gitIgnored.mockReturnValue(new Promise(() => {}))
    rerender(workspace('c'))
    expect(result.current).toEqual([])
    rerender(workspace('a'))
    expect(result.current).toEqual(['dist'])
  })
})
