import { beforeEach, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-items/work-item-types'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { singlePaneLayoutSnapshot } from '../../../terminals/layout/terminal-single-pane-layout'
import { makeTerminalTab } from '../../../terminals/testing/terminal-row.test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../worktrees-slice-test-harness'

const { exactLookup } = vi.hoisted(() => ({ exactLookup: vi.fn() }))
vi.mock('@/lib/work-items/github/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemByOwnerRepoForSource: exactLookup
}))

const workspaceId = 'repo::/worktree'
const leaf = '11111111-1111-4111-8111-111111111111'
function context(tabId = 'tab-1') {
  return {
    tabId,
    paneKey: makePaneKey(tabId, leaf),
    ptyId: `pty-${tabId}`,
    executionHostId: 'local' as const
  }
}
function link(number: number) {
  return {
    number,
    url: `https://github.com/acme/orca/pull/${number}`,
    slug: { owner: 'acme', repo: 'orca' }
  }
}
function review(number: number): GitHubWorkItem {
  return {
    id: String(number),
    repoId: 'repo',
    type: 'pr',
    number,
    title: 'Another target',
    url: link(number).url,
    state: 'open',
    branchName: 'feature',
    headSha: 'abc123',
    labels: [],
    updatedAt: '2026-01-01',
    author: null
  }
}
async function flush() {
  for (let i = 0; i < 400; i++) {
    await Promise.resolve()
  }
}
function setup() {
  const store = createTestStore()
  const branchLookup = vi.fn().mockResolvedValue(null)
  Object.defineProperty(window.api, 'hostedReview', {
    configurable: true,
    value: { forBranch: branchLookup }
  })
  store.setState({
    repos: [{ id: 'repo', path: '/repo', displayName: 'Orca', addedAt: 0, badgeColor: '' }],
    worktreesByRepo: {
      repo: [makeWorktree({ id: workspaceId, repoId: 'repo', linkedPR: 7 })]
    },
    tabsByWorktree: {
      [workspaceId]: ['tab-1', 'tab-2'].map((id) =>
        makeTerminalTab({ id, worktreeId: workspaceId, ptyId: `pty-${id}` })
      )
    },
    terminalLayoutsByTabId: {
      'tab-1': singlePaneLayoutSnapshot(leaf, 'pty-tab-1'),
      'tab-2': singlePaneLayoutSnapshot(leaf, 'pty-tab-2')
    },
    ptyIdsByTabId: { 'tab-1': ['pty-tab-1'], 'tab-2': ['pty-tab-2'] },
    agentStatusByPaneKey: {}
  })
  const pending = new Map<number, { resolve: (value: GitHubWorkItem | null) => void }>()
  exactLookup.mockImplementation(({ number }: { number: number }) => {
    const deferred = Promise.withResolvers<GitHubWorkItem | null>()
    pending.set(number, deferred)
    return deferred.promise
  })
  function observeBurst() {
    for (const number of [100, 101, 102, 103]) {
      store.getState().observeTerminalGitHubPullRequestLink(workspaceId, link(number), context())
    }
  }
  function closePane() {
    store.setState({
      tabsByWorktree: {
        [workspaceId]: [
          makeTerminalTab({ id: 'tab-2', worktreeId: workspaceId, ptyId: 'pty-tab-2' })
        ]
      },
      terminalLayoutsByTabId: { 'tab-2': singlePaneLayoutSnapshot(leaf, 'pty-tab-2') },
      ptyIdsByTabId: { 'tab-2': ['pty-tab-2'] }
    })
  }
  return { store, branchLookup, pending, observeBurst, closePane }
}

beforeEach(() => {
  vi.clearAllMocks()
  exactLookup.mockReset()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
})

it('keeps workspace attachments unchanged after closed-pane lookups settle', async () => {
  const { store, pending, observeBurst, closePane } = setup()
  observeBurst()
  await flush()

  closePane()
  for (const deferred of pending.values()) {
    deferred.resolve(null)
  }
  await flush()

  expect(
    getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0]).map((item) => item.number)
  ).toEqual([7])
})

it('attaches a current pane review after closed-pane lookups settle', async () => {
  const { store, pending, observeBurst, closePane } = setup()
  observeBurst()
  await flush()

  closePane()
  store.getState().observeTerminalGitHubPullRequestLink(workspaceId, link(1000), context('tab-2'))
  await flush()

  pending.get(100)?.resolve(null)
  await flush()

  pending.get(1000)?.resolve(review(1000))
  pending.get(101)?.resolve(null)
  pending.get(102)?.resolve(null)
  await flush()

  expect(
    getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0]).map((item) => item.number)
  ).toEqual([7, 1000])
})
