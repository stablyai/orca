/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeMergeReviewActionArgs } from './merge-review-flow'

const mocks = vi.hoisted(() => ({
  state: {
    openModal: vi.fn(),
    setRightSidebarTab: vi.fn(),
    setRightSidebarOpen: vi.fn()
  },
  activateAndRevealWorktree: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  reject: vi.fn(),
  sync: vi.fn(),
  accept: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

import {
  runWorktreeMergeReviewAccept,
  runWorktreeMergeReviewReject,
  runWorktreeMergeReviewSync
} from './merge-review-flow'

const args: WorktreeMergeReviewActionArgs = {
  worktreePath: '/repo/feature',
  worktreeId: 'repo::feature',
  repoId: 'repo',
  mainWorktreeId: 'repo::main'
}

/** The flow is fire-and-forget; drain its microtask chain before asserting. */
async function settle(): Promise<void> {
  await vi.waitFor(() => {
    expect(
      mocks.toast.success.mock.calls.length +
        mocks.toast.error.mock.calls.length +
        mocks.toast.info.mock.calls.length +
        mocks.toast.warning.mock.calls.length +
        mocks.state.openModal.mock.calls.length
    ).toBeGreaterThan(0)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      git: {
        worktreeMergeReviewSync: mocks.sync,
        worktreeMergeReviewAccept: mocks.accept,
        worktreeMergeReviewReject: mocks.reject
      }
    }
  })
})

describe('runWorktreeMergeReviewSync', () => {
  it('reports the merged stat', async () => {
    mocks.sync.mockResolvedValue({
      kind: 'merged',
      branch: 'feature',
      targetBranch: 'main',
      stat: ' a.txt | 1 +',
      conflicts: [],
      includedUncommittedChanges: false,
      stashedMainChanges: false
    })

    runWorktreeMergeReviewSync(args)
    await settle()

    expect(mocks.sync).toHaveBeenCalledWith({ worktreePath: '/repo/feature' })
    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Merged into the main worktree — awaiting review',
      {
        description: ' a.txt | 1 +'
      }
    )
  })

  // Why: a conflicted merge is only useful if the user lands on the panel that can resolve it.
  it('reveals the main checkout’s Source Control panel on conflicts', async () => {
    mocks.sync.mockResolvedValue({
      kind: 'merged',
      branch: 'feature',
      targetBranch: 'main',
      stat: '',
      conflicts: ['base.txt'],
      includedUncommittedChanges: false,
      stashedMainChanges: false
    })

    runWorktreeMergeReviewSync(args)
    await settle()

    expect(mocks.toast.warning).toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo::main', {
      providesInitialSurface: true
    })
    expect(mocks.state.setRightSidebarTab).toHaveBeenCalledWith('source-control')
    expect(mocks.state.setRightSidebarOpen).toHaveBeenCalledWith(true)
  })

  it('surfaces a refusal as an error toast', async () => {
    mocks.sync.mockRejectedValue(new Error('The main checkout is on a detached HEAD.'))

    runWorktreeMergeReviewSync(args)
    await settle()

    expect(mocks.toast.error).toHaveBeenCalledWith('The main checkout is on a detached HEAD.')
  })
})

describe('runWorktreeMergeReviewReject', () => {
  it('opens the confirmation dialog instead of acting, and re-enters with assumeYes', async () => {
    mocks.reject.mockResolvedValueOnce({ kind: 'needs-confirmation', paths: ['base.txt'] })

    runWorktreeMergeReviewReject(args)
    await settle()

    expect(mocks.reject).toHaveBeenCalledWith({ worktreePath: '/repo/feature' })
    expect(mocks.state.openModal).toHaveBeenCalledWith('merge-review-reject', {
      worktreePath: '/repo/feature',
      worktreeId: 'repo::feature',
      repoId: 'repo',
      mainWorktreeId: 'repo::main',
      paths: ['base.txt']
    })
    // Nothing was discarded yet — the first call only asks.
    expect(mocks.toast.success).not.toHaveBeenCalled()

    mocks.reject.mockResolvedValueOnce({ kind: 'rejected' })
    runWorktreeMergeReviewReject(args, true)
    await settle()

    expect(mocks.reject).toHaveBeenLastCalledWith({
      worktreePath: '/repo/feature',
      assumeYes: true
    })
    expect(mocks.toast.success).toHaveBeenCalledWith('Merge undone')
  })

  it('undoes a clean review without a dialog', async () => {
    mocks.reject.mockResolvedValue({ kind: 'rejected' })

    runWorktreeMergeReviewReject(args)
    await settle()

    expect(mocks.state.openModal).not.toHaveBeenCalled()
    expect(mocks.toast.success).toHaveBeenCalledWith('Merge undone')
  })
})

describe('runWorktreeMergeReviewAccept', () => {
  it('reports the commit', async () => {
    mocks.accept.mockResolvedValue({ kind: 'committed', summary: 'abc1234 Merge branch feature' })

    runWorktreeMergeReviewAccept(args)
    await settle()

    expect(mocks.toast.success).toHaveBeenCalledWith('Merge committed', {
      description: 'abc1234 Merge branch feature'
    })
  })
})
