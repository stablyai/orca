import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { resetHostedReviewLinkMutationGenerationForTests } from './hosted-review-link-mutation'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

beforeEach(() => {
  vi.clearAllMocks()
  resetWorktreeSliceModuleMemory()
  resetRemoteRuntimeMocks()
  resetHostedReviewLinkMutationGenerationForTests()
})

// #32918: one project at the same path on two hosts shares the id `repoId::path`.
const id = 'repo1::/srv/ai-tools'

function storeWith(...rows: Partial<Worktree>[]) {
  const store = createTestStore()
  const worktrees = rows.map((row) =>
    makeWorktree({ id, repoId: 'repo1', path: '/srv/ai-tools', ...row })
  )
  store.setState({ worktreesByRepo: { repo1: worktrees } })
  return store
}

function twinStore() {
  return storeWith(
    { hostId: 'runtime:env-a', head: 'aaa', branch: 'refs/heads/master', displayName: 'master' },
    { hostId: 'runtime:env-b', head: 'bbb', branch: 'refs/heads/feature', displayName: 'feature' }
  )
}

describe('updateWorktreeGitIdentity with a same-path twin on another host', () => {
  it('leaves both copies alone when the answering host is unknown', () => {
    const store = twinStore()

    store
      .getState()
      .updateWorktreeGitIdentity(id, { head: 'ccc', branch: 'refs/heads/other' }, null)

    const [onA, onB] = store.getState().worktreesByRepo.repo1
    expect(onA.branch).toBe('refs/heads/master')
    expect(onB.branch).toBe('refs/heads/feature')
  })

  it("clears only the switching twin's push target and review link, on its own host", async () => {
    const pushTarget = { remoteName: 'fork', branchName: 'old/review-head' }
    const store = storeWith(
      { hostId: 'local', branch: 'refs/heads/stack/two', linkedPR: 7, pushTarget },
      { hostId: 'ssh:box-b', branch: 'refs/heads/stack/one', linkedPR: 101, pushTarget }
    )

    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/stack/two' }, 'ssh:box-b')

    await vi.waitFor(() => expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(1))
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: id,
        executionHostId: 'ssh:box-b',
        updates: expect.objectContaining({ linkedPR: null, pushTarget: undefined })
      })
    )
    const [localAfter, remoteAfter] = store.getState().worktreesByRepo.repo1
    expect(localAfter).toMatchObject({ linkedPR: 7, pushTarget })
    expect(remoteAfter).toMatchObject({ branch: 'refs/heads/stack/two', pushTarget: undefined })
  })
})

describe('updateWorktreeGitIdentity host matching', () => {
  it("reaches a paired server's SSH checkout through its runtime alias, not its twin", () => {
    const store = storeWith(
      { hostId: 'local', branch: 'refs/heads/master' },
      {
        hostId: 'ssh:private-target',
        runtimeOwnerEnvironmentId: 'hub-a',
        branch: 'refs/heads/master'
      }
    )

    store
      .getState()
      .updateWorktreeGitIdentity(id, { branch: 'refs/heads/feature' }, 'runtime:hub-a')

    const [local, paired] = store.getState().worktreesByRepo.repo1
    expect(local.branch).toBe('refs/heads/master')
    expect(paired.branch).toBe('refs/heads/feature')
  })
})
