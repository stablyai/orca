import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { resetHostedReviewLinkMutationGenerationForTests } from './worktrees'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'
import {
  getHostedReviewPushTargetLookup,
  pushTargetPR
} from './worktrees/metadata/hosted-review-push-target'
import { findWorktreeRepo } from '../github/linked-pr-repository'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))
vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))

const repo: Repo = {
  id: 'repo1',
  path: '/repo1',
  displayName: 'relayto-docker',
  badgeColor: '#000',
  addedAt: 0,
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/relayto/relayto-docker',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:relayto/relayto-docker.git'
  }
}
const prAt = (slug: string): WorkspaceAttachment => ({
  provider: 'github',
  type: 'pr',
  number: 2383,
  url: `https://github.com/${slug}/pull/2383`
})
const OTHER_REPO_PR = prAt('relayto/relayto-frontend')
const SAME_REPO_PR = prAt('relayto/relayto-docker')

function row(linked: WorkspaceAttachment) {
  return makeWorktree({
    id: 'repo1::/path/wt1',
    repoId: 'repo1',
    path: '/path/wt1',
    branch: 'refs/heads/main',
    linkedPR: linked.number,
    linkedItems: [linked]
  })
}

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetHostedReviewLinkMutationGenerationForTests()
})

describe('a PR linked from another repository', () => {
  it('survives a branch switch, which still clears a same-repo link', async () => {
    const store = createTestStore()
    store.setState({ repos: [repo], worktreesByRepo: { repo1: [row(OTHER_REPO_PR)] } })

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', { branch: 'refs/heads/other' })
    await Promise.resolve()

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/other',
      linkedPR: 2383
    })
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()

    store.setState({ worktreesByRepo: { repo1: [row(SAME_REPO_PR)] } })
    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', { branch: 'refs/heads/other' })
    await Promise.resolve()

    expect(store.getState().worktreesByRepo.repo1[0].linkedPR).toBeNull()
  })

  it('never resolves a push target from this repository’s PR with the same number', async () => {
    const store = createTestStore()
    store.setState({
      repos: [repo],
      worktreesByRepo: { repo1: [makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1' })] }
    })

    await store
      .getState()
      .updateWorktreeMeta('repo1::/path/wt1', { linkedItems: [OTHER_REPO_PR], linkedPR: 2383 })

    expect(store.getState().worktreesByRepo.repo1[0].linkedPR).toBe(2383)
    expect(mockApi.worktrees.resolvePrBase).not.toHaveBeenCalled()
    expect(getHostedReviewPushTargetLookup(row(OTHER_REPO_PR), repo)).toBeNull()
    expect(getHostedReviewPushTargetLookup(row(SAME_REPO_PR), repo)?.key).toContain('github:2383')
  })

  it('a branch switch clears only the push target, keeping the link', async () => {
    const store = createTestStore()
    const pushTarget = { remoteName: 'origin', branchName: 'old/head' }
    store.setState({
      repos: [repo],
      worktreesByRepo: { repo1: [{ ...row(OTHER_REPO_PR), pushTarget }] }
    })

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', { branch: 'refs/heads/other' })
    await vi.waitFor(() => expect(mockApi.worktrees.updateMeta).toHaveBeenCalled())

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({ linkedPR: 2383 })
    expect(store.getState().worktreesByRepo.repo1[0].pushTarget).toBeUndefined()
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({ updates: { pushTarget: undefined } })
    )
  })

  it('upgrading a bare link to another repository drops the push target resolved for the bare number', async () => {
    const store = createTestStore()
    const bare = { provider: 'github' as const, type: 'pr' as const, number: 2383 }
    store.setState({
      repos: [repo],
      worktreesByRepo: {
        repo1: [{ ...row(bare), pushTarget: { remoteName: 'origin', branchName: 'docker-pr' } }]
      }
    })

    await store
      .getState()
      .updateWorktreeMeta('repo1::/path/wt1', { linkedItems: [OTHER_REPO_PR], linkedPR: 2383 })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      linkedPR: 2383,
      linkedItems: [OTHER_REPO_PR]
    })
    expect(store.getState().worktreesByRepo.repo1[0].pushTarget).toBeUndefined()
  })

  it('a push-target restore that finishes after the link moved to another repository is dropped', async () => {
    const store = createTestStore()
    const bare = { provider: 'github' as const, type: 'pr' as const, number: 2383 }
    const lookup = Promise.withResolvers<{
      baseBranch: string
      pushTarget: { remoteName: string; branchName: string }
    }>()
    mockApi.worktrees.resolvePrBase.mockReturnValueOnce(lookup.promise)
    store.setState({ repos: [repo], worktreesByRepo: { repo1: [row(bare)] } })

    const restoring = store.getState().ensureHostedReviewPushTarget('repo1::/path/wt1')
    store.setState({ worktreesByRepo: { repo1: [row(OTHER_REPO_PR)] } })
    lookup.resolve({
      baseBranch: 'origin/docker-pr',
      pushTarget: { remoteName: 'origin', branchName: 'docker-pr' }
    })
    await restoring

    expect(mockApi.worktrees.resolvePrBase).toHaveBeenCalledWith({
      repoId: 'repo1',
      prNumber: 2383
    })
    expect(store.getState().worktreesByRepo.repo1[0].pushTarget).toBeUndefined()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it.each([
    [
      'an SSH checkout behind a paired server',
      [{ ...repo, executionHostId: 'runtime:env-1' as const, connectionId: 'target' }],
      { hostId: 'ssh:target' as const, runtimeOwnerEnvironmentId: 'env-1' }
    ],
    // Without its Repo the row cannot prove the URL is its own, so nothing destructive runs.
    ['a row whose repository is unknown', [], {}]
  ])('keeps the link and derives no push target for %s', async (_label, repos, owner) => {
    const store = createTestStore()
    const linked = { ...row(OTHER_REPO_PR), ...owner }
    store.setState({ repos, worktreesByRepo: { repo1: [linked] } })

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', { branch: 'refs/heads/other' })
    await Promise.resolve()

    expect(store.getState().worktreesByRepo.repo1[0].linkedPR).toBe(2383)
    expect(pushTargetPR(linked, { linkedPR: 2383 }, repos)).toBeNull()
    expect(getHostedReviewPushTargetLookup(linked, findWorktreeRepo(repos, linked))).toBeNull()
  })
})
