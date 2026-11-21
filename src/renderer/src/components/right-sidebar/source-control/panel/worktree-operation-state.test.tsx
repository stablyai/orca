// @vitest-environment happy-dom
import '../../../../../../shared/worktree/host-qualified-identity'

import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { useSourceControlCommitAction } from '../commit/use-commit-action'
import { useSourceControlWorktreeOperationState } from './use-worktree-operation-state'
import './worktree-operation-store'
import { SourceControlScopeProvider } from './worktree-scope'

const git = vi.hoisted(() => ({
  commit: vi.fn<(context: { connectionId?: string }, message: string) => Promise<unknown>>()
}))
vi.mock('@/runtime/source-control/git/runtime-git-sync-client', () => ({
  commitRuntimeGit: git.commit,
  completeRuntimeGitMerge: vi.fn()
}))

const initialAppState = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  git.commit.mockReset()
  useAppStore.setState(initialAppState, true)
})

function sectionWrapper(
  worktreeId: string,
  executionHostId: ExecutionHostId,
  isActive = () => true
) {
  const worktree = makeWorktree(worktreeId, worktreeId, { instanceId: 'instance-1' })
  const repo = {
    ...makeRepo(),
    connectionId: executionHostId === 'local' ? null : executionHostId.slice('ssh:'.length)
  }
  const owner = {
    worktreeId,
    repoId: repo.id,
    executionHostId,
    worktree,
    attachedAt: 1,
    repo,
    placementWorkspaceId: 'folder:feature'
  }
  return ({ children }: { children: ReactNode }) => (
    <SourceControlScopeProvider owner={owner} active={isActive()}>
      {children}
    </SourceControlScopeProvider>
  )
}

function useCommitSection(worktreeId: string) {
  const state = useSourceControlWorktreeOperationState({
    activeWorktreeId: worktreeId,
    activeWorktreeInstanceId: 'instance-1',
    conflictOperation: 'unknown'
  })
  const action = useSourceControlCommitAction({
    activeRepoTarget: { kind: 'local' },
    activeWorktree: null,
    activeWorktreeId: worktreeId,
    beginGitBranchCompareRequest: vi.fn(),
    commitMessage: state.commitMessage,
    compareBaseRef: null,
    operationStore: state.operationStore,
    refreshActiveGitStatusAfterMutation: async () => {},
    refreshBranchCompareRef: { current: async () => {} },
    refreshGitHistoryRef: { current: async () => {} },
    stagedCount: 1,
    unresolvedConflictCount: 0,
    updateCommitDraft: state.updateCommitDraft,
    worktreePath: `/tmp/${worktreeId}`
  })
  return { ...state, ...action }
}

it('keeps drafts of same-id worktrees on different hosts apart and across remounts', () => {
  const local = renderHook(() => useCommitSection('wt-drafts'), {
    wrapper: sectionWrapper('wt-drafts', 'local')
  })
  const remote = renderHook(() => useCommitSection('wt-drafts'), {
    wrapper: sectionWrapper('wt-drafts', 'ssh:box')
  })
  act(() => local.result.current.updateCommitDraft('fix: local copy'))
  act(() => remote.result.current.updateCommitDraft('fix: remote copy'))
  local.unmount()

  const remounted = renderHook(() => useCommitSection('wt-drafts'), {
    wrapper: sectionWrapper('wt-drafts', 'local')
  })
  expect(remounted.result.current.commitMessage).toBe('fix: local copy')
  expect(remote.result.current.commitMessage).toBe('fix: remote copy')
})
