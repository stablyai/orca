// @vitest-environment happy-dom
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'

import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { useSourceControlCommitAction } from '../commit/use-commit-action'
import { useSourceControlWorktreeOperationState } from './use-worktree-operation-state'
import { getWorktreeOperationStore, writeWorktreeCommitDraft } from './worktree-operation-store'
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

it('keeps a slow commit latched after collapse so the re-expanded section cannot resubmit', async () => {
  let finishCommit: (result: { success: boolean }) => void = () => {}
  git.commit.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishCommit = resolve
      })
  )
  let active = true
  const wrapper = sectionWrapper('wt-slow', 'local', () => active)
  const first = renderHook(() => useCommitSection('wt-slow'), { wrapper })
  act(() => first.result.current.updateCommitDraft('feat: slow'))
  let pending: Promise<boolean> | undefined
  act(() => {
    pending = first.result.current.handleCommit()
  })
  active = false
  first.rerender()
  const reexpanded = first
  expect(reexpanded.result.current.isCommitting).toBe(true)
  await act(async () => {
    expect(await reexpanded.result.current.handleCommit()).toBe(false)
  })
  expect(git.commit).toHaveBeenCalledTimes(1)

  await act(async () => {
    finishCommit({ success: true })
    expect(await pending).toBe(true)
  })
  expect(reexpanded.result.current.operationStore.getState().isCommitting).toBe(false)
  expect(reexpanded.result.current.isCommitting).toBe(true)
  expect(reexpanded.result.current.commitMessage).toBe('feat: slow')
  active = true
  first.rerender()
  expect(reexpanded.result.current.isCommitting).toBe(false)
  expect(reexpanded.result.current.commitMessage).toBe('')
})

it('commits a same-id host twin over its own connection without blocking the other copy', async () => {
  git.commit.mockImplementation(() => new Promise(() => {}))
  const local = renderHook(() => useCommitSection('wt-twin'), {
    wrapper: sectionWrapper('wt-twin', 'local')
  })
  const remote = renderHook(() => useCommitSection('wt-twin'), {
    wrapper: sectionWrapper('wt-twin', 'ssh:box')
  })
  act(() => remote.result.current.updateCommitDraft('fix: remote'))
  act(() => {
    void remote.result.current.handleCommit()
  })

  expect(git.commit).toHaveBeenCalledWith(
    expect.objectContaining({ worktreeId: 'wt-twin', connectionId: 'box' }),
    'fix: remote'
  )
  expect(remote.result.current.isCommitting).toBe(true)
  expect(local.result.current.isCommitting).toBe(false)
})

it('gives a worktree id reused by a new instance a fresh record', () => {
  const original = getWorktreeOperationStore('wt-reused', 'local', 'instance-1')
  original.setState({ draft: 'stale', isCommitting: true })
  act(() => {
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [makeWorktree('wt-reused', 'wt-reused', { instanceId: 'instance-2' })]
      }
    })
  })

  const reused = getWorktreeOperationStore('wt-reused', 'local', 'instance-2')
  expect(reused).not.toBe(original)
  expect(reused.getState().draft).toBe('')
  expect(reused.getState().isCommitting).toBe(false)
})

it('keeps a live draft when a non-authoritative catalog scan briefly drops the row', () => {
  const row = makeWorktree('wt-blip', 'wt-blip', { instanceId: 'instance-1' })
  act(() => useAppStore.setState({ worktreesByRepo: { 'repo-1': [row] } }))
  const store = getWorktreeOperationStore('wt-blip', 'local', 'instance-1')
  writeWorktreeCommitDraft(store, 'feat: keep me')
  act(() => useAppStore.setState({ worktreesByRepo: { 'repo-1': [] } }))
  act(() => useAppStore.setState({ worktreesByRepo: { 'repo-1': [row] } }))

  const after = getWorktreeOperationStore('wt-blip', 'local', 'instance-1')
  expect(after).toBe(store)
  expect(after.getState().draft).toBe('feat: keep me')
})

it('retires only the removed host owner on authoritative purge and fences late draft writes', () => {
  const local = getWorktreeOperationStore('wt-removed', 'local', 'instance-1')
  const remote = getWorktreeOperationStore('wt-removed', 'ssh:box', 'instance-1')
  writeWorktreeCommitDraft(local, 'local draft')
  writeWorktreeCommitDraft(remote, 'remote draft')
  useAppStore
    .getState()
    .purgeWorktreeTerminalState([hostWorktreeTarget({ id: 'wt-removed', hostId: 'ssh:box' })])
  writeWorktreeCommitDraft(remote, 'late remote draft')
  const replacement = getWorktreeOperationStore('wt-removed', 'ssh:box', 'instance-1')
  expect(replacement).not.toBe(remote)
  expect(replacement.getState().draft).toBe('')
  expect(getWorktreeOperationStore('wt-removed', 'local', 'instance-1')).toBe(local)
  expect(local.getState().draft).toBe('local draft')
  useAppStore
    .getState()
    .purgeWorktreeTerminalState([hostWorktreeTarget({ id: 'wt-removed', hostId: 'local' })])
  expect(getWorktreeOperationStore('wt-removed', 'local', 'instance-1').getState().draft).toBe('')
})
