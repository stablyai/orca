// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { GitDiffResult } from '../../../../../../shared/git-diff-compare-types'
import { getWorkingTreeCompareEntries } from '@/store/slices/editor/git/working-tree-compare-entries'
import { fetchCombinedDiffSection } from './fetch-combined-diff-section'

const mocks = vi.hoisted(() => ({
  branch: vi.fn(),
  working: vi.fn(),
  ownerSettings: { owner: 'remote' }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: {} }) } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: () => mocks.ownerSettings
}))
vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitBranchDiff: mocks.branch,
  getRuntimeGitDiff: mocks.working,
  getRuntimeGitCommitDiff: vi.fn()
}))
vi.mock('./combined-diff-section-connection', () => ({
  getCombinedDiffSectionConnectionId: () => 'ssh-owner'
}))

const text = (originalContent: string, modifiedContent: string): GitDiffResult => ({
  kind: 'text',
  originalContent,
  modifiedContent,
  originalIsBinary: false,
  modifiedIsBinary: false
})

describe('working-tree comparison reads', () => {
  it('reads the branch-head rename source and the current working-tree destination on the same host', async () => {
    mocks.branch.mockResolvedValue(text('base content', 'committed content'))
    mocks.working.mockResolvedValue(text('', 'saved content'))
    const [entry] = getWorkingTreeCompareEntries(
      [{ path: 'second.ts', oldPath: 'first.ts', status: 'renamed' }],
      [
        { path: 'third.ts', oldPath: 'second.ts', status: 'renamed', area: 'staged' },
        { path: 'third.ts', oldPath: 'second.ts', status: 'modified', area: 'unstaged' }
      ]
    )
    const branchCompare = {
      baseRef: 'main',
      baseOid: 'base',
      mergeBase: 'fork',
      headOid: 'head',
      compareRef: 'feature',
      compareVersion: 'version'
    }
    const file: OpenFile = {
      id: 'comparison',
      filePath: '/remote/repo',
      relativePath: 'All Changes',
      worktreeId: 'wt',
      language: 'plaintext',
      isDirty: false,
      mode: 'diff',
      diffSource: 'combined-branch',
      compareWorkingTree: true,
      runtimeEnvironmentId: 'remote-owner',
      branchCompare
    }
    const result = await fetchCombinedDiffSection({
      file,
      entry,
      branchCompare,
      commitCompare: null,
      isBranchMode: true,
      isAllMode: false,
      isCommitMode: false
    })
    expect(mocks.branch).toHaveBeenCalledWith(
      {
        settings: mocks.ownerSettings,
        worktreeId: 'wt',
        worktreePath: '/remote/repo',
        connectionId: 'ssh-owner'
      },
      expect.objectContaining({ filePath: 'second.ts', oldPath: 'first.ts' })
    )
    expect(mocks.working).toHaveBeenCalledWith(
      {
        settings: mocks.ownerSettings,
        worktreeId: 'wt',
        worktreePath: '/remote/repo',
        connectionId: 'ssh-owner'
      },
      { filePath: 'third.ts', staged: false, compareAgainstHead: true }
    )
    expect(result).toMatchObject({
      originalContent: 'base content',
      modifiedContent: 'saved content'
    })
  })
})
