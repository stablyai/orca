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
import { getHostedReviewPushTargetLookup } from './worktrees/metadata/hosted-review-push-target'

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
})
