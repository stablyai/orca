import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { resetHostedReviewLinkMutationGenerationForTests } from './worktrees'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  bumpHostedReviewLinkMutationGeneration,
  migrateHostedReviewLinkMutationGeneration,
  sanitizeHostedReviewLinksForBranchClears
} from './worktrees/metadata/hosted-review-link-mutation'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

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
  it("writes one host's git status only to that host's copy", () => {
    const store = twinStore()

    store
      .getState()
      .updateWorktreeGitIdentity(id, { head: 'aaa2', branch: 'refs/heads/master' }, 'runtime:env-a')

    const [onA, onB] = store.getState().worktreesByRepo.repo1
    expect(onA).toMatchObject({ head: 'aaa2', branch: 'refs/heads/master' })
    expect(onB).toMatchObject({ head: 'bbb', branch: 'refs/heads/feature', displayName: 'feature' })
  })

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

describe('a twin review-clear tombstone', () => {
  it("guards only the switching copy's refetched rows, never its sibling's", () => {
    const store = storeWith(
      { hostId: 'local', branch: 'refs/heads/stack/two', linkedPR: 7 },
      { hostId: 'ssh:box-b', branch: 'refs/heads/stack/one', linkedPR: 101 }
    )
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/stack/two' }, 'ssh:box-b')

    const [sibling, staleRefetch] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({
        id,
        repoId: 'repo1',
        hostId: 'local',
        branch: 'refs/heads/stack/two',
        linkedPR: 7
      }),
      makeWorktree({
        id,
        repoId: 'repo1',
        hostId: 'ssh:box-b',
        branch: 'refs/heads/stack/one',
        linkedPR: 101
      })
    ])

    expect(sibling.linkedPR).toBe(7)
    expect(staleRefetch).toMatchObject({ branch: 'refs/heads/stack/two', linkedPR: null })
  })
})

describe('twin review-clear tombstones when both copies switch', () => {
  it('keep guarding the first copy after the second clears', () => {
    const store = storeWith(
      { hostId: 'local', branch: 'refs/heads/a1', linkedPR: 1 },
      { hostId: 'ssh:box-b', branch: 'refs/heads/b1', linkedPR: 2 }
    )
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/a2' }, 'local')
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/b2' }, 'ssh:box-b')

    const [first] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({ id, repoId: 'repo1', hostId: 'local', branch: 'refs/heads/a1', linkedPR: 1 })
    ])

    expect(first).toMatchObject({ branch: 'refs/heads/a2', linkedPR: null })
  })
})

describe('a twin review-clear tombstone across a rename', () => {
  it('still guards the renamed copy', () => {
    const store = storeWith(
      { hostId: 'local', branch: 'refs/heads/a1' },
      { hostId: 'ssh:box-b', branch: 'refs/heads/b1', linkedPR: 2 }
    )
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/b2' }, 'ssh:box-b')
    const renamed = 'repo1::/srv/ai-tools-renamed'
    migrateHostedReviewLinkMutationGeneration(id, renamed)

    const [stale] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({
        id: renamed,
        repoId: 'repo1',
        hostId: 'ssh:box-b',
        branch: 'refs/heads/b1',
        linkedPR: 2
      })
    ])

    expect(stale).toMatchObject({ branch: 'refs/heads/b2', linkedPR: null })
  })
})

describe('a twin review-clear tombstone after the sibling goes away', () => {
  it('still drives a retry of the clear on the next branch switch', async () => {
    const store = storeWith(
      { hostId: 'local', branch: 'refs/heads/a1' },
      { hostId: 'ssh:box-b', branch: 'refs/heads/b1', linkedPR: 2 }
    )
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/b2' }, 'ssh:box-b')
    await vi.waitFor(() => expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(1))
    const [, remote] = store.getState().worktreesByRepo.repo1
    store.setState({ worktreesByRepo: { repo1: [remote] } })

    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/b3' }, 'ssh:box-b')

    await vi.waitFor(() => expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(2))
  })
})

describe('a provenance twin review-clear tombstone', () => {
  it('spares the sibling another paired server publishes under the same SSH host id', () => {
    const shared = { hostId: 'ssh:shared' as const, branch: 'refs/heads/stack/one' }
    const store = storeWith(
      { ...shared, runtimeOwnerEnvironmentId: 'hub-a', linkedPR: 1 },
      { ...shared, runtimeOwnerEnvironmentId: 'hub-b', linkedPR: 2 }
    )
    store
      .getState()
      .updateWorktreeGitIdentity(id, { branch: 'refs/heads/stack/two' }, 'runtime:hub-a')

    const [sibling] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({
        id,
        repoId: 'repo1',
        ...shared,
        runtimeOwnerEnvironmentId: 'hub-b',
        linkedPR: 2
      })
    ])

    expect(sibling.linkedPR).toBe(2)
    expect(store.getState().worktreesByRepo.repo1[1].linkedPR).toBe(2)
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

  it('keeps two paired servers apart when both publish the same SSH host id', () => {
    const store = storeWith(
      { hostId: 'ssh:shared', runtimeOwnerEnvironmentId: 'hub-a', branch: 'refs/heads/main' },
      { hostId: 'ssh:shared', runtimeOwnerEnvironmentId: 'hub-b', branch: 'refs/heads/feature' }
    )

    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/main' }, 'runtime:hub-a')

    expect(store.getState().worktreesByRepo.repo1[1].branch).toBe('refs/heads/feature')
  })
})

describe('review-clear tombstones are always keyed by the copy', () => {
  it('still guard a legacy unstamped row after its listing stamps it', () => {
    const store = storeWith({ branch: 'refs/heads/a1', linkedPR: 1 })
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/a2' }, 'ssh:box')

    const [stale] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({ id, repoId: 'repo1', hostId: 'ssh:box', branch: 'refs/heads/a1', linkedPR: 1 })
    ])

    expect(stale).toMatchObject({ branch: 'refs/heads/a2', linkedPR: null })
  })

  it('never rewrite a same-path twin that arrives after a lone copy cleared', () => {
    const store = storeWith({ hostId: 'local', branch: 'refs/heads/a1', linkedPR: 1 })
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/a2' }, 'local')

    const [newcomer] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({
        id,
        repoId: 'repo1',
        hostId: 'ssh:box-b',
        branch: 'refs/heads/b1',
        linkedPR: 2
      })
    ])

    expect(newcomer).toMatchObject({ branch: 'refs/heads/b1', linkedPR: 2 })
  })

  it('still guard a runtime row once its listing adds the server provenance', () => {
    const store = storeWith({ hostId: 'runtime:env-a', branch: 'refs/heads/a1', linkedPR: 1 })
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/a2' }, 'runtime:env-a')

    const [stale] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({
        id,
        repoId: 'repo1',
        hostId: 'runtime:env-a',
        runtimeOwnerEnvironmentId: 'env-a',
        branch: 'refs/heads/a1',
        linkedPR: 1
      })
    ])

    expect(stale).toMatchObject({ branch: 'refs/heads/a2', linkedPR: null })
  })

  it('still guard a legacy local row after discovery stamps it local', () => {
    const store = storeWith({ branch: 'refs/heads/a1', linkedPR: 1 })
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/a2' }, 'local')

    const [stale] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({ id, repoId: 'repo1', hostId: 'local', branch: 'refs/heads/a1', linkedPR: 1 })
    ])

    expect(stale).toMatchObject({ branch: 'refs/heads/a2', linkedPR: null })
  })

  it("add the publishing server's provenance to a partially stamped SSH row", () => {
    const store = storeWith({ hostId: 'ssh:x', branch: 'refs/heads/a1', linkedPR: 1 })
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/srv/ai-tools',
          displayName: 'ai-tools',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'runtime:hub'
        }
      ]
    })
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/a2' }, 'ssh:x')

    const [stale] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({
        id,
        repoId: 'repo1',
        hostId: 'ssh:x',
        runtimeOwnerEnvironmentId: 'hub',
        branch: 'refs/heads/a1',
        linkedPR: 1
      })
    ])

    expect(stale).toMatchObject({ branch: 'refs/heads/a2', linkedPR: null })
  })

  it("follow a runtime row's own host, not its repo's, when provenance is backfilled", () => {
    const store = storeWith({ hostId: 'runtime:env-b', branch: 'refs/heads/a1', linkedPR: 1 })
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/srv/ai-tools',
          displayName: 'ai-tools',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'runtime:env-a'
        }
      ]
    })
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/a2' }, 'runtime:env-b')

    const [stale] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({
        id,
        repoId: 'repo1',
        hostId: 'runtime:env-b',
        runtimeOwnerEnvironmentId: 'env-b',
        branch: 'refs/heads/a1',
        linkedPR: 1
      })
    ])

    expect(stale).toMatchObject({ branch: 'refs/heads/a2', linkedPR: null })
  })

  it("never give a local copy a paired server's provenance", () => {
    const store = storeWith({ hostId: 'local', branch: 'refs/heads/a1', linkedPR: 1 })
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/srv/ai-tools',
          displayName: 'ai-tools',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'runtime:hub'
        }
      ]
    })
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/a2' }, 'local')

    const [stale] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({ id, repoId: 'repo1', hostId: 'local', branch: 'refs/heads/a1', linkedPR: 1 })
    ])

    expect(stale).toMatchObject({ branch: 'refs/heads/a2', linkedPR: null })
  })

  it("keep a paired server's provenance when its SSH host answers", () => {
    const paired = { hostId: 'ssh:x' as const, runtimeOwnerEnvironmentId: 'hub' }
    const store = storeWith({ ...paired, branch: 'refs/heads/a1', linkedPR: 1 })
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/a2' }, 'ssh:x')

    const [stale] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({ id, repoId: 'repo1', ...paired, branch: 'refs/heads/a1', linkedPR: 1 })
    ])

    expect(stale).toMatchObject({ branch: 'refs/heads/a2', linkedPR: null })
  })

  it('let a relink of the still-unstamped legacy row drop its stamped guard', () => {
    const store = storeWith({ branch: 'refs/heads/a1', linkedPR: 1 })
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/a2' }, 'ssh:box')
    bumpHostedReviewLinkMutationGeneration(id, {})

    const [relinked] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({ id, repoId: 'repo1', hostId: 'ssh:box', branch: 'refs/heads/a2', linkedPR: 9 })
    ])

    expect(relinked.linkedPR).toBe(9)
  })

  it("keep the sibling's guard when one copy is relinked", () => {
    const store = storeWith(
      { hostId: 'local', branch: 'refs/heads/a1', linkedPR: 1 },
      { hostId: 'ssh:box-b', branch: 'refs/heads/b1', linkedPR: 2 }
    )
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/a2' }, 'local')
    store.getState().updateWorktreeGitIdentity(id, { branch: 'refs/heads/b2' }, 'ssh:box-b')
    bumpHostedReviewLinkMutationGeneration(id, { hostId: 'local' })

    const [staleRemote] = sanitizeHostedReviewLinksForBranchClears([
      makeWorktree({
        id,
        repoId: 'repo1',
        hostId: 'ssh:box-b',
        branch: 'refs/heads/b1',
        linkedPR: 2
      })
    ])

    expect(staleRemote).toMatchObject({ branch: 'refs/heads/b2', linkedPR: null })
  })
})
