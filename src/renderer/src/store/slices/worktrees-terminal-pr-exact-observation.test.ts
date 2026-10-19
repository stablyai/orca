import { beforeEach, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

const { exactLookup } = vi.hoisted(() => ({ exactLookup: vi.fn() }))
vi.mock('@/lib/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemByOwnerRepoForSource: exactLookup
}))
const url = 'https://github.com/acme/orca/pull/42'
const link = { number: 42, url, slug: { owner: 'acme', repo: 'orca' } }
const secondary: GitHubWorkItem = {
  id: '42',
  repoId: 'repo',
  type: 'pr',
  number: 42,
  title: 'Release target',
  url,
  state: 'open',
  branchName: 'feature',
  headSha: 'abc123',
  baseRefName: 'release',
  labels: [],
  updatedAt: '2026-01-01',
  author: null
}
function setup() {
  const store = createTestStore()
  const workspace = makeWorktree({ id: 'repo::/worktree', repoId: 'repo', linkedPR: null })
  const firstBranchReview: HostedReviewInfo = {
    provider: 'github',
    number: 7,
    title: 'First branch PR',
    state: 'open',
    status: 'success',
    url: 'https://github.com/acme/orca/pull/7',
    mergeable: 'MERGEABLE',
    updatedAt: '2026-01-01'
  }
  const branchLookup = vi.fn().mockResolvedValue(firstBranchReview)
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: branchLookup }
  })
  store.setState({
    repos: [{ id: 'repo', path: '/repo', displayName: 'Orca', addedAt: 0, badgeColor: '' }],
    worktreesByRepo: { repo: [workspace] }
  })
  return { store, workspace, branchLookup }
}
async function flush() {
  for (let index = 0; index < 30; index++) {
    await Promise.resolve()
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
  exactLookup.mockReset().mockResolvedValue(secondary)
})

it('confirms a second PR by exact source and head when branch discovery would return only its first PR', async () => {
  const { store, workspace, branchLookup } = setup()
  store.getState().observeTerminalGitHubPullRequestLink(workspace.id, link)
  await flush()
  expect(getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0])).toMatchObject([
    { provider: 'github', type: 'pr', number: 42 }
  ])
  expect(branchLookup).not.toHaveBeenCalled()
  expect(exactLookup).toHaveBeenCalledWith(
    expect.objectContaining({
      owner: 'acme',
      repo: 'orca',
      host: 'github.com',
      number: 42,
      type: 'pr',
      sourceContext: expect.objectContaining({ hostId: 'local', repoId: 'repo' })
    })
  )
})

it.each([
  { type: 'issue' as const },
  { number: 99 },
  { url: 'https://github.com/foreign/repo/pull/42' },
  { branchName: 'unrelated' },
  { headSha: 'other-head' }
])(
  'rejects contradictory exact evidence without using an implicit fallback: %j',
  async (change) => {
    const { store, workspace, branchLookup } = setup()
    exactLookup.mockResolvedValue({ ...secondary, ...change })
    store.getState().observeTerminalGitHubPullRequestLink(workspace.id, link)
    await flush()
    expect(getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0])).toEqual([])
    expect(branchLookup).not.toHaveBeenCalled()
  }
)

it('does not attach a source rejected by the configured-remote exact lookup', async () => {
  const { store, workspace, branchLookup } = setup()
  exactLookup.mockResolvedValue(null)
  store.getState().observeTerminalGitHubPullRequestLink(workspace.id, link)
  await flush()
  expect(getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0])).toEqual([])
  expect(branchLookup).toHaveBeenCalledTimes(1)
})

it.each([false, true])(
  'checks a saved push branch and its late replacement=%s',
  async (replace) => {
    const { store, workspace, branchLookup } = setup()
    const pending = Promise.withResolvers<GitHubWorkItem | null>()
    exactLookup.mockReturnValue(pending.promise)
    const saved = {
      ...workspace,
      branch: 'refs/heads/local-copy',
      pushTarget: { remoteName: 'origin', branchName: 'feature' }
    }
    store.setState({ worktreesByRepo: { repo: [saved] } })
    store.getState().observeTerminalGitHubPullRequestLink(workspace.id, link)
    if (replace) {
      store.setState({
        worktreesByRepo: {
          repo: [{ ...saved, pushTarget: { remoteName: 'origin', branchName: 'replacement' } }]
        }
      })
    }
    pending.resolve(secondary)
    await flush()
    expect(getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0])).toHaveLength(
      replace ? 0 : 1
    )
    expect(branchLookup).not.toHaveBeenCalled()
  }
)

it('retains branch confirmation on an older host without exact head evidence', async () => {
  const { store, workspace, branchLookup } = setup()
  exactLookup.mockResolvedValue({ ...secondary, headSha: undefined })
  branchLookup.mockResolvedValue({ provider: 'github', number: 42, url })
  store.getState().observeTerminalGitHubPullRequestLink(workspace.id, link)
  await flush()
  expect(getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0])).toHaveLength(1)
  expect(branchLookup).toHaveBeenCalledTimes(1)
})
