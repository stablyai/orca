import { beforeEach, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-item-types'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { singlePaneLayoutSnapshot } from '../../../terminals/terminal-single-pane-layout'
import { makeTerminalTab } from '../../../terminals/terminal-row.test-fixture'
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

it('preserves distinct live confirmations on one branch without replacing the manual primary', async () => {
  const { store, pending, observeBurst, branchLookup } = setup()
  observeBurst()
  await flush()
  let completed = 0
  while (completed < 4) {
    const batch = [...pending]
    pending.clear()
    for (const [number, deferred] of batch) {
      deferred.resolve(review(number))
    }
    completed += batch.length
    await flush()
  }
  expect(branchLookup).not.toHaveBeenCalled()
  const items = getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0])
  expect(items.map((item) => item.number).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
    7, 100, 101, 102, 103
  ])
  expect(store.getState().worktreesByRepo.repo[0].linkedPR).toBe(7)
})

it('drops stale queued starts and fallback reads after the pane closes', async () => {
  const { store, pending, observeBurst, closePane, branchLookup } = setup()
  observeBurst()
  await flush()
  expect(exactLookup).toHaveBeenCalledWith(expect.objectContaining({ number: 100 }))
  closePane()
  for (const deferred of pending.values()) {
    deferred.resolve(null)
  }
  await flush()
  expect(exactLookup).not.toHaveBeenCalledWith(expect.objectContaining({ number: 103 }))
  expect(branchLookup).not.toHaveBeenCalled()
  expect(
    getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0]).map((item) => item.number)
  ).toEqual([7])
})

it('retains occupied native permits until settlement after their pane closes', async () => {
  const { store, pending, observeBurst, closePane, branchLookup } = setup()
  observeBurst()
  await flush()
  expect(exactLookup).toHaveBeenCalledWith(expect.objectContaining({ number: 100 }))
  closePane()
  store.getState().observeTerminalGitHubPullRequestLink(workspaceId, link(1000), context('tab-2'))
  await flush()
  expect(exactLookup).not.toHaveBeenCalledWith(expect.objectContaining({ number: 1000 }))
  pending.get(100)?.resolve(null)
  await flush()
  expect(exactLookup).toHaveBeenLastCalledWith(expect.objectContaining({ number: 1000 }))
  pending.get(1000)?.resolve(review(1000))
  pending.get(101)?.resolve(null)
  pending.get(102)?.resolve(null)
  await flush()
  expect(branchLookup).not.toHaveBeenCalled()
  expect(
    getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0]).map((item) => item.number)
  ).toEqual([7, 1000])
})
