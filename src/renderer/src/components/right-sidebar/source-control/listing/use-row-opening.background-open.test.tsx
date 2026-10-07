// why: the hook renders through React DOM, so @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitBranchCompareSummary } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'

type ToastAction = { label: string; onClick: () => void }
type ToastOptions = { id?: string; action?: ToastAction }

const mocks = vi.hoisted(() => {
  const toastCalls: { title: string; options?: ToastOptions }[] = []
  const toastFn = Object.assign(
    (title: string, options?: ToastOptions) => {
      toastCalls.push({ title, options })
    },
    { error: () => {}, success: () => {}, dismiss: () => {} }
  )
  const activations: string[] = []
  return { toastCalls, toastFn, activations }
})

vi.mock('sonner', () => ({ toast: mocks.toastFn }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: (worktreeId: string) => {
    mocks.activations.push(worktreeId)
    return { worktreeId }
  }
}))

import { useSourceControlRowOpening } from './use-row-opening'

const initialAppState = useAppStore.getInitialState()
const worktreeA = makeWorktree({ id: 'repo1::/repo1', repoId: 'repo1', path: '/repo1' })
const worktreeB = makeWorktree({
  id: 'repo1::/repo1-b',
  repoId: 'repo1',
  path: '/repo1-b',
  displayName: 'feature-b'
})
const entry: GitStatusEntry = { path: 'b.ts', area: 'unstaged', status: 'modified' }
const branchSummary: GitBranchCompareSummary = {
  baseRef: 'main',
  baseOid: 'base',
  compareRef: 'HEAD',
  headOid: 'head',
  mergeBase: 'merge-base',
  changedFiles: 1,
  status: 'ready'
}

function renderRowOpening(worktreeId: string, worktreePath: string) {
  return renderHook(() =>
    useSourceControlRowOpening({
      isMac: true,
      activeWorktreeId: worktreeId,
      worktreePath,
      visibleSelectionEntries: [],
      branchSummary
    })
  )
}

beforeEach(() => {
  mocks.toastCalls.length = 0
  mocks.activations.length = 0
  useAppStore.setState(initialAppState, true)
  useAppStore.setState({
    activeWorktreeId: worktreeA.id,
    worktreesByRepo: { repo1: [worktreeA, worktreeB] },
    repos: [{ ...TEST_REPO, kind: 'git', connectionId: null }]
  })
})

afterEach(cleanup)

describe('source control opens in a worktree that is not on screen', () => {
  it('shows where a pinned sibling diff opened and switches on demand', () => {
    const { result } = renderRowOpening(worktreeB.id, worktreeB.path)
    act(() => result.current.handleOpenDiff(entry))

    expect(mocks.toastCalls).toHaveLength(1)
    expect(mocks.toastCalls[0].title).toBe('Opened in feature-b')
    expect(mocks.toastCalls[0].options?.action?.label).toBe('Switch')
    mocks.toastCalls[0].options?.action?.onClick()
    expect(mocks.activations).toEqual([worktreeB.id])
    expect(useAppStore.getState().activeFileIdByWorktree[worktreeB.id]).toBeTruthy()
  })

  it('also covers committed-on-branch diffs', () => {
    const { result } = renderRowOpening(worktreeB.id, worktreeB.path)
    act(() => result.current.openCommittedDiff({ path: 'b.ts', status: 'modified' }))
    expect(mocks.toastCalls.map((call) => call.title)).toEqual(['Opened in feature-b'])
  })

  it('stays silent for the active worktree', () => {
    const { result } = renderRowOpening(worktreeA.id, worktreeA.path)
    act(() => result.current.handleOpenDiff(entry))
    act(() => result.current.openCommittedDiff({ path: 'a.ts', status: 'modified' }))
    expect(mocks.toastCalls).toEqual([])
  })
})
