import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { getRebaseOperation } from '../../../../main/git/source-control/git-conflict-operation'
import { listWorktreesStrict } from '../../../../main/git/worktrees/catalog/worktree-listing'
import { mergeWorktree } from '../../../../main/ipc/worktree-metadata-merge'
import { mergeWorktreeMetaForWrite } from '../../../../main/persistence/loading-store/worktree-meta-write-normalization'
import { readGitCommonHeadIdentities } from '../../../../main/ipc/worktrees/creation/worktree-head-identity-reader'
import { applyWorktreeHeadIdentities } from '../../hooks/worktree-head-identity-apply'
import { confirmNoRebaseBeforeReviewAction } from '../../lib/review-action-rebase-check'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  worktreeListMock
} from './worktrees/worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))
vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => activeStore.getState() } }))

let activeStore: ReturnType<typeof createTestStore>
const tempPaths: string[] = []
const REVIEW = {
  provider: 'github' as const,
  type: 'pr' as const,
  number: 37557,
  title: 'Respect manual order',
  url: 'https://github.com/stablyai/orca/pull/37557'
}
const PUSH_TARGET = {
  remoteName: 'pr-davefano-orca',
  branchName: 'feature',
  remoteUrl: 'https://github.com/davefano/orca.git'
}

function gitIn(cwd: string) {
  return (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A linked review checkout on `localBranch` whose commit conflicts with `main`. */
function createReviewRepo(localBranch: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-rebase-retention-')))
  tempPaths.push(root)
  const main = join(root, 'main')
  const review = join(root, 'review')
  execFileSync('git', ['init', '--quiet', main])
  const git = gitIn(main)
  // Why symbolic-ref: `init -b` needs Git 2.28.
  git('symbolic-ref', 'HEAD', 'refs/heads/main')
  git('config', 'user.name', 'Orca Test')
  git('config', 'user.email', 'orca@example.test')
  git('config', 'commit.gpgSign', 'false')
  git('config', 'core.hooksPath', '.git/no-hooks')
  writeFileSync(join(main, 'file.txt'), 'base\n')
  git('add', 'file.txt')
  git('commit', '--quiet', '-m', 'base')
  git('branch', 'other')
  git('worktree', 'add', '--quiet', '-b', localBranch, review)
  writeFileSync(join(review, 'file.txt'), 'review\n')
  gitIn(review)('commit', '--quiet', '-am', 'review')
  writeFileSync(join(main, 'file.txt'), 'main\n')
  git('commit', '--quiet', '-am', 'main')
  return { main, review, git: gitIn(review), id: `repo1::${review}` }
}

/** Persisted metadata as main stores it; renderer writes land here through updateMeta. */
function createPersistence(initial: WorktreeMeta) {
  let meta = initial
  mockApi.worktrees.updateMeta.mockImplementation(async ({ updates }) => {
    meta = mergeWorktreeMetaForWrite(meta, updates)
  })
  return {
    read: () => meta,
    /** Another client (CLI or mobile) writes without this window's mutation generation. */
    writeExternally: (updates: Partial<WorktreeMeta>) => {
      meta = mergeWorktreeMetaForWrite(meta, updates)
    }
  }
}

type Persistence = ReturnType<typeof createPersistence>

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function reviewMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    instanceId: 'review-instance',
    linkedPR: REVIEW.number,
    linkedWorkItem: REVIEW,
    linkedItems: [REVIEW],
    pushTarget: PUSH_TARGET,
    ...overrides
  }
}

/** The real listing (with its host verdicts) and the real head watcher, in production order. */
async function observe(
  repo: ReturnType<typeof createReviewRepo>,
  persisted: Persistence,
  options: { listing?: boolean; watcher?: boolean; dropVerdict?: boolean } = {}
): Promise<void> {
  const store = activeStore
  if (options.listing !== false) {
    const rows = (await listWorktreesStrict(repo.main))
      .filter((git) => git.path === repo.review)
      .map((git) => {
        const row = mergeWorktree('repo1', git, persisted.read())
        if (options.dropVerdict) {
          delete row.detachedRebase
        }
        return row
      })
    worktreeListMock.mockResolvedValue(rows)
    await store.getState().fetchWorktrees('repo1')
  }
  if (options.watcher !== false) {
    const { identities } = await readGitCommonHeadIdentities(join(repo.main, '.git'))
    applyWorktreeHeadIdentities(
      { repoId: 'repo1', identities },
      {
        getWorktreesForRepo: (repoId) => store.getState().worktreesByRepo[repoId],
        updateWorktreeGitIdentity: store.getState().updateWorktreeGitIdentity
      }
    )
  }
  await settle()
}

function pauseRebase(repo: ReturnType<typeof createReviewRepo>): void {
  expect(spawnSync('git', ['rebase', '--merge', 'main'], { cwd: repo.review }).status).toBe(1)
}

function continueRebase(repo: ReturnType<typeof createReviewRepo>): void {
  writeFileSync(join(repo.review, 'file.txt'), 'resolved\n')
  repo.git('add', 'file.txt')
  repo.git('-c', 'core.editor=true', 'rebase', '--continue')
}

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  activeStore = createTestStore()
  activeStore.setState({ worktreesByRepo: {} })
})

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('active review ownership across a real rebase', () => {
  it('keeps the persisted review, push target and reference through rebase and return', async () => {
    const repo = createReviewRepo('feature')
    const persisted = createPersistence(reviewMeta())
    await observe(repo, persisted)
    pauseRebase(repo)
    await observe(repo, persisted, { listing: false })
    await observe(repo, persisted)
    continueRebase(repo)
    await observe(repo, persisted, { listing: false })
    await observe(repo, persisted)

    expect(persisted.read()).toMatchObject({
      linkedPR: 37557,
      pushTarget: PUSH_TARGET,
      linkedItems: [expect.objectContaining({ number: 37557 })]
    })
  })

  it('still clears the active review and push target, but not the reference, on a real switch', async () => {
    const repo = createReviewRepo('feature')
    const persisted = createPersistence(reviewMeta())
    await observe(repo, persisted)
    repo.git('checkout', '--quiet', '--detach')
    await observe(repo, persisted, { listing: false })
    repo.git('checkout', '--quiet', 'other')
    await observe(repo, persisted, { listing: false })

    expect(persisted.read().linkedPR).toBeNull()
    expect(persisted.read().pushTarget).toBeUndefined()
    expect(persisted.read().linkedItems).toEqual([expect.objectContaining({ number: 37557 })])
  })

  it('clears on a switch the listing sees after the head watcher saw the detach', async () => {
    const repo = createReviewRepo('feature')
    const persisted = createPersistence(reviewMeta())
    await observe(repo, persisted)
    repo.git('checkout', '--quiet', '--detach')
    await observe(repo, persisted, { listing: false })
    repo.git('checkout', '--quiet', 'other')
    await observe(repo, persisted, { watcher: false })

    expect(persisted.read().linkedPR).toBeNull()
    expect(persisted.read().pushTarget).toBeUndefined()
  })

  it('clears a local reattach observed by listing without clearing its same-ID remote twin', async () => {
    const repo = createReviewRepo('feature')
    const persisted = createPersistence(reviewMeta())
    await observe(repo, persisted)
    const local = activeStore.getState().worktreesByRepo.repo1[0]
    const remote = {
      ...local,
      hostId: 'ssh:box-b' as const,
      instanceId: 'remote-instance',
      linkedPR: 987,
      pushTarget: { remoteName: 'origin', branchName: 'remote-review' }
    }
    activeStore.setState({ worktreesByRepo: { repo1: [local, remote] } })
    repo.git('checkout', '--quiet', '--detach')
    await observe(repo, persisted, { listing: false })
    repo.git('checkout', '--quiet', 'other')
    await observe(repo, persisted)

    expect(persisted.read().linkedPR).toBeNull()
    expect(persisted.read().pushTarget).toBeUndefined()
    expect(activeStore.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/other',
      linkedPR: null,
      pushTarget: undefined
    })
    expect(activeStore.getState().worktreesByRepo.repo1[1]).toEqual(remote)
  })

  it('clears the old review after an unrelated linked issue changes while detached', async () => {
    const repo = createReviewRepo('feature')
    const persisted = createPersistence(reviewMeta())
    await observe(repo, persisted)
    repo.git('checkout', '--quiet', '--detach')
    await observe(repo, persisted, { listing: false })
    const issue = {
      provider: 'github' as const,
      type: 'issue' as const,
      number: 42,
      title: 'Unrelated work item',
      url: 'https://github.com/stablyai/orca/issues/42'
    }
    persisted.writeExternally({ linkedWorkItem: issue })
    await observe(repo, persisted)
    repo.git('checkout', '--quiet', 'other')
    await observe(repo, persisted)

    expect(persisted.read().linkedPR).toBeNull()
    expect(persisted.read().pushTarget).toBeUndefined()
    expect(persisted.read().linkedWorkItem).toEqual(issue)
    expect(persisted.read().linkedItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'issue', number: 42 })])
    )
  })

  it('keeps a same-number review relinked to another repository while detached', async () => {
    const repo = createReviewRepo('feature')
    const persisted = createPersistence(reviewMeta())
    await observe(repo, persisted)
    repo.git('checkout', '--quiet', '--detach')
    await observe(repo, persisted, { listing: false })
    const relinked = { ...REVIEW, url: 'https://github.com/other/project/pull/37557' }
    persisted.writeExternally({ linkedWorkItem: relinked })
    await observe(repo, persisted)
    repo.git('checkout', '--quiet', 'other')
    await observe(repo, persisted)

    expect(persisted.read()).toMatchObject({ linkedPR: 37557, linkedWorkItem: relinked })
    expect(persisted.read().pushTarget).toBeUndefined()
  })

  it('keeps an unverified cold-start ownership when a renamed local branch returns', async () => {
    const repo = createReviewRepo('review-123')
    const persisted = createPersistence(reviewMeta())
    pauseRebase(repo)
    await observe(repo, persisted, { dropVerdict: true })
    continueRebase(repo)
    await observe(repo, persisted, { listing: false })
    await observe(repo, persisted, { dropVerdict: true })

    expect(persisted.read()).toMatchObject({ linkedPR: 37557, pushTarget: PUSH_TARGET })
  })

  it('keeps a relinked review and rejects a stale push target while the partial clear is pending', async () => {
    const repo = createReviewRepo('feature')
    const persisted = createPersistence(reviewMeta())
    await observe(repo, persisted)
    repo.git('checkout', '--quiet', '--detach')
    await observe(repo, persisted, { listing: false })
    const relinked = {
      ...REVIEW,
      number: 40000,
      url: 'https://github.com/stablyai/orca/pull/40000'
    }
    persisted.writeExternally({ linkedPR: 40000, linkedWorkItem: relinked })
    await observe(repo, persisted)
    const pending = Promise.withResolvers<void>()
    const save = mockApi.worktrees.updateMeta.getMockImplementation()!
    mockApi.worktrees.updateMeta.mockImplementationOnce(async (args) => {
      await pending.promise
      return save(args)
    })
    try {
      repo.git('checkout', '--quiet', 'other')
      await observe(repo, persisted, { listing: false })
      await observe(repo, persisted, { watcher: false })

      expect(activeStore.getState().worktreesByRepo.repo1[0]).toMatchObject({
        linkedPR: 40000,
        pushTarget: undefined
      })
    } finally {
      pending.resolve()
      await settle()
    }

    expect(persisted.read()).toMatchObject({ linkedPR: 40000, linkedWorkItem: relinked })
    expect(persisted.read().pushTarget).toBeUndefined()
    expect(persisted.read().linkedItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ number: 37557 })])
    )
  })

  it('keeps a review linked after the first detached observation when a branch appears', async () => {
    const repo = createReviewRepo('feature')
    repo.git('checkout', '--quiet', '--detach')
    const persisted = createPersistence(reviewMeta())
    await observe(repo, persisted)
    const relinked = {
      ...REVIEW,
      number: 40000,
      url: 'https://github.com/stablyai/orca/pull/40000'
    }
    const pushTarget = { remoteName: 'origin', branchName: 'new-review' }
    persisted.writeExternally({ linkedPR: 40000, linkedWorkItem: relinked, pushTarget })
    await observe(repo, persisted)
    repo.git('checkout', '--quiet', 'other')
    await observe(repo, persisted)

    expect(persisted.read()).toMatchObject({
      linkedPR: 40000,
      pushTarget: { remoteName: 'origin', branchName: 'new-review' }
    })
    expect(activeStore.getState().worktreesByRepo.repo1[0]).toMatchObject({
      linkedPR: 40000,
      pushTarget: { remoteName: 'origin', branchName: 'new-review' }
    })
  })

  it('drops the stale push target after an unlink while detached, then a switch', async () => {
    const repo = createReviewRepo('feature')
    const persisted = createPersistence(reviewMeta())
    await observe(repo, persisted)
    repo.git('checkout', '--quiet', '--detach')
    await observe(repo, persisted, { listing: false })
    persisted.writeExternally({ linkedPR: null, suppressedGitHubPR: REVIEW.number })
    await observe(repo, persisted)
    repo.git('checkout', '--quiet', 'other')
    await observe(repo, persisted, { listing: false })

    expect(persisted.read().linkedPR).toBeNull()
    expect(persisted.read().pushTarget).toBeUndefined()
  })
})

describe('review action rebase check at the action boundary', () => {
  it('rejects while the owner is rebasing even though the renderer row still says attached', async () => {
    const repo = createReviewRepo('feature')
    const persisted = createPersistence(reviewMeta())
    await observe(repo, persisted)
    // The renderer's verdict call reaches the real owner-side metadata read.
    Object.assign(mockApi, {
      git: {
        rebaseOperation: (args: { worktreePath: string }) => getRebaseOperation(args.worktreePath)
      }
    })
    try {
      pauseRebase(repo)
      expect(activeStore.getState().worktreesByRepo.repo1[0].branch).toBe('refs/heads/feature')

      await expect(confirmNoRebaseBeforeReviewAction(repo.id)).resolves.toBe(false)
      continueRebase(repo)
      await expect(confirmNoRebaseBeforeReviewAction(repo.id)).resolves.toBe(true)
    } finally {
      Reflect.deleteProperty(mockApi, 'git')
    }
  })
})
