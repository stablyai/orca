vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HostedReviewInfo,
  HostedReviewForBranchArgs
} from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { makeWorktree } from '../worktree.test-fixture'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../worktrees-slice-test-harness'

function installReviewRead() {
  const read = vi.fn<(args: HostedReviewForBranchArgs) => Promise<HostedReviewInfo | null>>()
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: read }
  })
  return read
}

const confirmedReview = (number: number): HostedReviewInfo => ({
  provider: 'github',
  number,
  title: 'Confirmed',
  state: 'open',
  status: 'success',
  mergeable: 'MERGEABLE',
  url: `https://github.com/acme/orca/pull/${number}`,
  updatedAt: '2026-01-01'
})

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('worktree remote runtime mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    Object.defineProperty(window.api, 'gh', {
      configurable: true,
      value: { workItemByOwnerRepo: vi.fn().mockResolvedValue(null) }
    })
  })

  it('preserves a manual primary while appending a PR confirmed after the selection changes', async () => {
    const store = createTestStore()
    let resolveLookup: (value: HostedReviewInfo | null) => void = () => {}
    installReviewRead().mockImplementation(
      () =>
        new Promise<HostedReviewInfo | null>((resolve) => {
          resolveLookup = resolve
        })
    )
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link',
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/pr-link'
      }
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    })

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    await vi.dynamicImportSettled()

    store.setState({
      worktreesByRepo: { repo1: [{ ...wt, linkedPR: 7 }] }
    })

    resolveLookup(confirmedReview(42))
    await vi.dynamicImportSettled()

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBe(7)
    expect(
      getWorkspaceAttachments(store.getState().worktreesByRepo.repo1[0]).map((item) => item.number)
    ).toEqual([7, 42])
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalled()
  })
})
