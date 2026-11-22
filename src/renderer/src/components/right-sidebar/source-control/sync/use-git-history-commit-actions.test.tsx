// @vitest-environment happy-dom

import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitCommitCompareResult } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitHistoryItem } from '../../../../../../shared/git/history/git-history-types'

const mocks = vi.hoisted(() => ({
  getRuntimeGitCommitCompare: vi.fn(),
  openCommitAllDiffs: vi.fn()
}))

vi.mock('@/runtime/source-control/git/runtime-git-diff-client', () => ({
  getRuntimeGitCommitCompare: mocks.getRuntimeGitCommitCompare
}))
vi.mock('@/runtime/source-control/git/runtime-git-working-tree-client', () => ({
  getRuntimeGitRemoteCommitUrl: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ openCommitAllDiffs: mocks.openCommitAllDiffs }) }
}))
vi.mock('../panel/worktree-scope', () => ({
  useSourceControlScope: () => null,
  sourceControlConnectionId: () => undefined
}))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: vi.fn()
}))
vi.mock('@/lib/agent-session/launch/shortcuts/agent-tab-shortcuts', () => ({
  resolveDefaultAgentForWorktreeNewTab: vi.fn()
}))
vi.mock('@/lib/agent-session/launch/inventory/agent-detection-target-inventory', () => ({
  getDetectionTargetIdentityForWorktree: vi.fn()
}))
vi.mock('@/lib/browser/workspace/workspace-browser-tab-open', () => ({
  openWorkspaceBrowserTab: vi.fn()
}))

import { useGitHistoryCommitActions } from './use-git-history-commit-actions'

const COMMIT: GitHistoryItem = { id: 'c1', parentIds: [], subject: 'c1', message: 'c1' }

function compare(path: string): GitCommitCompareResult {
  return {
    summary: {
      commitOid: 'c1',
      parentOid: 'p1',
      compareRef: 'c1',
      baseRef: 'p1',
      changedFiles: 1,
      status: 'ready'
    },
    entries: [{ path, status: 'modified' }]
  }
}

let latest: ReturnType<typeof useGitHistoryCommitActions> | null = null

function Probe({ worktreeId }: { worktreeId: string }): null {
  latest = useGitHistoryCommitActions({
    activeWorktreeId: worktreeId,
    worktreePath: `/${worktreeId}`,
    activeRepoTarget: { kind: 'local' },
    resolveSplitTargetGroupId: () => undefined
  })
  return null
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  latest = null
})

describe('useGitHistoryCommitActions context fencing', () => {
  it('keeps a late compare for the previous worktree out of the current cache', async () => {
    const fromA = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare.mockReturnValueOnce(fromA.promise)
    const root = render(<Probe worktreeId="A" />)
    const loadA = latest!.loadCommitFiles(COMMIT)

    await act(async () => {
      root.rerender(<Probe worktreeId="B" />)
    })
    await act(async () => {
      fromA.resolve(compare('from-a.ts'))
    })
    await loadA

    mocks.getRuntimeGitCommitCompare.mockResolvedValueOnce(compare('from-b.ts'))
    await expect(latest!.loadCommitFiles(COMMIT)).resolves.toEqual([
      { path: 'from-b.ts', status: 'modified' }
    ])
  })

  it('drops an Open diff whose load finishes after a worktree switch', async () => {
    const fromA = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare.mockReturnValueOnce(fromA.promise)
    const root = render(<Probe worktreeId="A" />)
    const opening = latest!.openHistoryCommitDiff(COMMIT)

    await act(async () => {
      root.rerender(<Probe worktreeId="B" />)
    })
    await act(async () => {
      fromA.resolve(compare('from-a.ts'))
    })
    await opening
    await act(() => Promise.resolve())

    expect(mocks.openCommitAllDiffs).not.toHaveBeenCalled()
  })
})
