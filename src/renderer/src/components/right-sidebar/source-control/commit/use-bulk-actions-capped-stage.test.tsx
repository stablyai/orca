// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'

const mocks = vi.hoisted(() => ({ bulkStage: vi.fn(), stageScope: vi.fn(), toastError: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => 'ssh-1' }))
vi.mock('@/runtime/runtime-git-client', () => ({
  bulkStageRuntimeGitPaths: (...args: unknown[]) => mocks.bulkStage(...args),
  stageRuntimeGitWorktreeScope: (...args: unknown[]) => mocks.stageScope(...args),
  bulkUnstageRuntimeGitPaths: vi.fn()
}))

import { useSourceControlBulkActions } from './use-bulk-actions'
import type { SourceControlEntryGroups } from '../listing/section-order'

function entry(path: string, area: GitStatusEntry['area']): GitStatusEntry {
  return { path, status: area === 'untracked' ? 'untracked' : 'modified', area }
}

function renderBulkActions(grouped: SourceControlEntryGroups, isStatusTruncated: boolean) {
  return renderHook(() =>
    useSourceControlBulkActions({
      selectedKeys: new Set(),
      flatEntriesByKey: new Map(),
      activeRepoSettings: null,
      activeWorktreeId: 'wt-1',
      worktreePath: '/repo',
      grouped,
      isStatusTruncated,
      clearSelection: () => {},
      refreshActiveGitStatusAfterMutation: async () => {}
    })
  )
}

const GROUPED: SourceControlEntryGroups = {
  staged: [],
  unstaged: [entry('a.ts', 'unstaged')],
  untracked: [entry('new.ts', 'untracked')]
}

beforeEach(() => {
  mocks.bulkStage.mockReset()
  mocks.bulkStage.mockResolvedValue(undefined)
  mocks.stageScope.mockReset()
  mocks.stageScope.mockResolvedValue(undefined)
  mocks.toastError.mockReset()
})

describe('Stage All on a capped status listing', () => {
  it('stages the listed paths when the listing is complete', async () => {
    const { result } = renderBulkActions(GROUPED, false)
    await act(() => result.current.handleStageAllPrimary())

    expect(mocks.bulkStage).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: '/repo', connectionId: 'ssh-1' }),
      ['a.ts', 'new.ts']
    )
    expect(mocks.stageScope).not.toHaveBeenCalled()
  })

  it('asks the host to stage everything when the listing hit its cap', async () => {
    const { result } = renderBulkActions(GROUPED, true)
    await act(() => result.current.handleStageAllPrimary())

    expect(mocks.stageScope).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: '/repo' }),
      'all'
    )
    expect(mocks.bulkStage).not.toHaveBeenCalled()
  })

  it('stages tracked changes on the host for the capped Changes section only', async () => {
    const { result } = renderBulkActions(GROUPED, true)
    await act(() => result.current.handleStageSectionPaths('unstaged', ['a.ts']))
    await act(() => result.current.handleStageSectionPaths('conflicts', ['c.ts']))

    expect(mocks.stageScope).toHaveBeenCalledWith(expect.anything(), 'tracked')
    expect(mocks.bulkStage).toHaveBeenCalledWith(expect.anything(), ['c.ts'])
  })

  it('reaches the hidden rest when every listed row is already staged', async () => {
    // A capped prefix of staged rows leaves no section or primary Stage All to press.
    const { result } = renderBulkActions(
      { staged: [entry('a.ts', 'staged')], unstaged: [], untracked: [] },
      true
    )
    await act(() => result.current.handleStageWorktreeChanges())

    expect(mocks.stageScope).toHaveBeenCalledWith(expect.anything(), 'all')
  })

  it('surfaces an older host that could not stage the whole worktree', async () => {
    mocks.stageScope.mockRejectedValue(new Error('host too old'))
    const { result } = renderBulkActions(GROUPED, true)
    await act(() => result.current.handleStageAllPrimary())

    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ description: expect.stringContaining('host too old') })
    )
    expect(result.current.isExecutingBulk).toBe(false)
  })
})
