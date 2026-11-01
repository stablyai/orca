import type { HostedReviewInfo, HostedReviewForBranchArgs } from '../../../../shared/hosted-review'
import { singlePaneLayoutSnapshot } from './terminal-helpers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTerminalTab, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import { makePaneKey } from '../../../../shared/stable-pane-id'

function installReviewRead() {
  const read = vi.fn<(args: HostedReviewForBranchArgs) => Promise<HostedReviewInfo | null>>()
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: read }
  })
  return read
}

const worktreeId = 'repo1::/path/wt1'
const url = 'https://github.com/acme/orca/pull/42'
const link = { url, slug: { owner: 'acme', repo: 'orca' }, number: 42 }
const leaf = '11111111-1111-4111-8111-111111111111'
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}
function setup() {
  const store = createTestStore()
  const readHostedReview = installReviewRead().mockResolvedValue({
    provider: 'github',
    number: 42,
    title: 'Second PR',
    state: 'open',
    url,
    status: 'success',
    updatedAt: '2026-01-01',
    mergeable: 'MERGEABLE'
  })
  store.setState({
    repos: [
      { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
    ],
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: worktreeId,
          repoId: 'repo1',
          linkedPR: 7,
          pushTarget: { remoteName: 'origin', branchName: 'feature' },
          linkedItems: [{ provider: 'github', type: 'pr', number: 7 }]
        })
      ]
    },
    tabsByWorktree: {
      [worktreeId]: [
        makeTerminalTab({ id: 'tab-1', worktreeId, ptyId: 'pty-tab-1' }),
        makeTerminalTab({ id: 'tab-2', worktreeId, ptyId: 'pty-tab-2' })
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': singlePaneLayoutSnapshot(leaf, 'pty-tab-1'),
      'tab-2': singlePaneLayoutSnapshot(leaf, 'pty-tab-2')
    },
    ptyIdsByTabId: { 'tab-1': ['pty-tab-1'], 'tab-2': ['pty-tab-2'] },
    agentStatusByPaneKey: {}
  })
  return { store, readHostedReview }
}
const context = (tabId: string) => ({
  tabId,
  paneKey: makePaneKey(tabId, leaf),
  ptyId: `pty-${tabId}`,
  executionHostId: 'local' as const
})
beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
})
describe('terminal reference evidence', () => {
  it('retains independently confirmed concurrent PRs when the first becomes the primary', async () => {
    const { store, readHostedReview } = setup()
    const initial = store.getState().worktreesByRepo.repo1[0]
    store.setState({
      worktreesByRepo: { repo1: [{ ...initial, linkedPR: null, linkedItems: [] }] }
    })
    const first = Promise.withResolvers<HostedReviewInfo | null>()
    const second = Promise.withResolvers<HostedReviewInfo | null>()
    readHostedReview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    store.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, context('tab-1'))
    store.getState().observeTerminalGitHubPullRequestLink(
      worktreeId,
      {
        ...link,
        number: 43,
        url: 'https://github.com/acme/orca/pull/43'
      },
      context('tab-2')
    )
    const review: HostedReviewInfo = {
      provider: 'github',
      number: 42,
      title: 'Confirmed',
      state: 'open',
      url,
      status: 'success',
      mergeable: 'MERGEABLE',
      updatedAt: '2026-01-01'
    }
    first.resolve(review)
    await flush()
    expect(store.getState().worktreesByRepo.repo1[0].linkedPR).toBe(42)
    second.resolve({ ...review, number: 43, url: 'https://github.com/acme/orca/pull/43' })
    await flush()
    const current = store.getState().worktreesByRepo.repo1[0]
    expect(current.linkedPR).toBe(42)
    expect(
      getWorkspaceAttachments(current).map((item) => [item.number, item.origins?.[0].tabId])
    ).toEqual([
      [42, 'tab-1'],
      [43, 'tab-2']
    ])
  })

  it('confirms a secondary review without publishing it into the primary branch cache', async () => {
    const { store } = setup()
    const workspace = store.getState().worktreesByRepo.repo1[0]
    const fetchHostedReviewForBranch = vi.fn()
    const primary: HostedReviewInfo = {
      provider: 'github',
      number: 7,
      title: 'Primary',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/7',
      status: 'failure',
      mergeable: 'MERGEABLE',
      updatedAt: '2026-01-01'
    }
    const hostedReviewCache = {
      'local::repo1::feature': { data: primary, fetchedAt: Date.now() }
    }
    store.setState({
      fetchHostedReviewForBranch,
      hostedReviewCache,
      worktreesByRepo: {
        repo1: [
          {
            ...workspace,
            linkedGitLabMR: null,
            linkedBitbucketPR: null,
            linkedAzureDevOpsPR: null,
            linkedGiteaPR: null,
            linkedItems: [
              ...getWorkspaceAttachments(workspace),
              {
                provider: 'github',
                type: 'pr',
                number: 42
              }
            ]
          }
        ]
      }
    })
    store.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, context('tab-1'))
    await flush()
    expect(fetchHostedReviewForBranch).not.toHaveBeenCalled()
    expect(store.getState().hostedReviewCache).toBe(hostedReviewCache)
    expect(
      getWorkspaceAttachments(store.getState().worktreesByRepo.repo1[0])[1].origins?.[0].tabId
    ).toBe('tab-1')
  })
  it('confirms on the terminal owner when another host has the same repository ID', async () => {
    const { store } = setup()
    const repo = store.getState().repos[0]
    const readHostedReview = installReviewRead().mockResolvedValue({
      provider: 'github',
      number: 42,
      title: 'Confirmed',
      state: 'open',
      url,
      status: 'success',
      mergeable: 'MERGEABLE',
      updatedAt: '2026-01-01'
    })
    store.setState({
      repos: [{ ...repo, executionHostId: 'runtime:other' }, repo]
    })
    store.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, context('tab-1'))
    await flush()
    expect(readHostedReview).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: repo.path,
        repoId: repo.id,
        repoOwnerExecutionHostId: 'local'
      })
    )
    expect(getWorkspaceAttachments(store.getState().worktreesByRepo.repo1[0])[1].origins).toEqual([
      expect.objectContaining({ hostId: 'local', tabId: 'tab-1' })
    ])
  })
  it('confirms a number-only secondary attachment without requiring it to be the primary review', async () => {
    const { store } = setup()
    const workspace = store.getState().worktreesByRepo.repo1[0]
    const readHostedReview = installReviewRead().mockResolvedValue({
      provider: 'github',
      number: 42,
      title: 'Secondary',
      state: 'open',
      url,
      status: 'success',
      mergeable: 'MERGEABLE',
      updatedAt: '2026-01-01'
    })
    store.setState({
      worktreesByRepo: {
        repo1: [
          {
            ...workspace,
            linkedItems: [
              ...getWorkspaceAttachments(workspace),
              {
                provider: 'github',
                type: 'pr',
                number: 42
              }
            ]
          }
        ]
      }
    })
    store.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, context('tab-1'))
    await flush()
    expect(readHostedReview).toHaveBeenCalledWith(expect.objectContaining({ linkedGitHubPR: 42 }))
    const current = store.getState().worktreesByRepo.repo1[0]
    expect(current.linkedPR).toBe(7)
    expect(getWorkspaceAttachments(current)[1].origins?.[0].tabId).toBe('tab-1')
  })
  it('rejects a different provider returned by owner-scoped branch confirmation', async () => {
    const { store } = setup()
    installReviewRead().mockResolvedValue({
      provider: 'gitlab',
      number: 42,
      title: 'Other provider',
      state: 'open',
      url,
      status: 'success',
      mergeable: 'MERGEABLE',
      updatedAt: '2026-01-01'
    })
    store.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, context('tab-1'))
    await flush()
    expect(getWorkspaceAttachments(store.getState().worktreesByRepo.repo1[0])).toHaveLength(1)
  })
  it('adds a second confirmed PR without changing which review is used for checks', async () => {
    const { store } = setup()
    store.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, context('tab-1'))
    await flush()
    const workspace = store.getState().worktreesByRepo.repo1[0]
    expect(workspace.linkedPR).toBe(7)
    expect(getWorkspaceAttachments(workspace).map((item) => item.number)).toEqual([7, 42])
    expect(getWorkspaceAttachments(workspace)[1].origins).toEqual([
      expect.objectContaining({ kind: 'observed', tabId: 'tab-1', hostId: 'local' })
    ])
  })
  it('records two terminals for one PR and keeps repeated evidence deduplicated', async () => {
    const { store, readHostedReview } = setup()
    for (const tabId of ['tab-1', 'tab-2', 'tab-2']) {
      store.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, context(tabId))
      await flush()
    }
    expect(
      getWorkspaceAttachments(store.getState().worktreesByRepo.repo1[0])[1].origins?.map(
        (origin) => origin.tabId
      )
    ).toEqual(['tab-1', 'tab-2'])
    expect(readHostedReview.mock.calls.filter(([args]) => args.active === true)).toHaveLength(1)
  })
  it('does not associate a same-number PR from a different repository', async () => {
    const { store } = setup()
    store
      .getState()
      .observeTerminalGitHubPullRequestLink(
        worktreeId,
        { ...link, url: 'https://github.com/other/repo/pull/42' },
        context('tab-1')
      )
    await flush()
    expect(getWorkspaceAttachments(store.getState().worktreesByRepo.repo1[0])).toHaveLength(1)
  })
  it('does not write after a failed confirmation', async () => {
    const { store, readHostedReview } = setup()
    readHostedReview.mockRejectedValue(new Error('Offline'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, context('tab-1'))
    await flush()
    expect(getWorkspaceAttachments(store.getState().worktreesByRepo.repo1[0])).toHaveLength(1)
    expect(warning).toHaveBeenCalled()
    warning.mockRestore()
  })
  it('ignores a stale PTY even when its caller supplies an execution host', async () => {
    const { store, readHostedReview } = setup()
    store.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, {
      ...context('tab-1'),
      ptyId: 'old-pty'
    })
    await flush()
    expect(readHostedReview).not.toHaveBeenCalled()
  })
  it('does not attribute a delayed confirmation after the pane is rebound', async () => {
    const { store, readHostedReview } = setup()
    let complete: (value: Awaited<ReturnType<typeof readHostedReview>>) => void = () => {}
    readHostedReview.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    store.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, context('tab-1'))
    await flush()
    store.setState({
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayoutSnapshot(leaf, 'replacement-pty') }
    })
    complete({
      provider: 'github',
      number: 42,
      title: 'Second PR',
      state: 'open',
      url,
      status: 'success',
      updatedAt: '2026-01-01',
      mergeable: 'MERGEABLE'
    })
    await flush()
    expect(getWorkspaceAttachments(store.getState().worktreesByRepo.repo1[0])).toHaveLength(1)
  })
  it('keeps a pending observation when only the terminal label changes', async () => {
    const { store, readHostedReview } = setup()
    const confirmed = await readHostedReview({ repoPath: '/repo', branch: 'branch' })
    let complete: (value: typeof confirmed) => void = () => {}
    readHostedReview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    store.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, context('tab-1'))
    await flush()
    store.setState({
      tabsByWorktree: {
        [worktreeId]: store
          .getState()
          .tabsByWorktree[worktreeId].map((tab) => ({ ...tab, customTitle: 'Renamed' }))
      }
    })
    complete(confirmed)
    await flush()
    expect(
      getWorkspaceAttachments(store.getState().worktreesByRepo.repo1[0]).map((item) => item.number)
    ).toEqual([7, 42])
  })
  it('rejects an explicit host that disagrees with the PTY owner', async () => {
    const { store, readHostedReview } = setup()
    store.getState().observeTerminalGitHubPullRequestLink(worktreeId, link, {
      ...context('tab-1'),
      executionHostId: 'ssh:other'
    })
    await flush()
    expect(readHostedReview).not.toHaveBeenCalled()
  })
})
