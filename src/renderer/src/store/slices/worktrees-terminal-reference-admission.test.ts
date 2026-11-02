import { beforeEach, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { createTerminalGitHubPRLinkDetector } from '../../../../shared/terminal-github-pr-link-detector'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { singlePaneLayoutSnapshot } from './terminal-helpers'
import { makeTerminalTab, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

const { exactLookup } = vi.hoisted(() => ({ exactLookup: vi.fn() }))
vi.mock('@/lib/github-work-item-source-lookup', () => ({
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
  let active = 0
  let peak = 0
  exactLookup.mockImplementation(({ number }: { number: number }) => {
    const deferred = Promise.withResolvers<GitHubWorkItem | null>()
    pending.set(number, deferred)
    active++
    peak = Math.max(peak, active)
    return deferred.promise.finally(() => {
      active--
    })
  })
  function observeBurst() {
    const detector = createTerminalGitHubPRLinkDetector()
    const links = detector(Array.from({ length: 100 }, (_, i) => `${link(i + 100).url}\n`).join(''))
    expect(links).toHaveLength(100)
    for (const observed of links) {
      store.getState().observeTerminalGitHubPullRequestLink(workspaceId, observed, context())
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
  return { store, branchLookup, pending, observeBurst, closePane, peak: () => peak }
}

beforeEach(() => {
  vi.clearAllMocks()
  exactLookup.mockReset()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
})

it('admits at most three confirmations and preserves every distinct live PR on the same branch', async () => {
  const { store, pending, observeBurst, peak, branchLookup } = setup()
  observeBurst()
  await flush()
  expect(exactLookup).toHaveBeenCalledTimes(3)
  let completed = 0
  while (completed < 100) {
    expect(pending.size).toBeGreaterThan(0)
    const batch = [...pending]
    pending.clear()
    for (const [number, deferred] of batch) {
      deferred.resolve(review(number))
    }
    completed += batch.length
    await flush()
  }
  expect(peak()).toBe(3)
  expect(exactLookup).toHaveBeenCalledTimes(100)
  expect(branchLookup).not.toHaveBeenCalled()
  const items = getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0])
  expect(items.map((item) => item.number).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
    7,
    ...Array.from({ length: 100 }, (_, i) => i + 100)
  ])
  expect(store.getState().worktreesByRepo.repo[0].linkedPR).toBe(7)
})

it('drops stale queued starts and fallback reads after the pane closes', async () => {
  const { store, pending, observeBurst, closePane, branchLookup } = setup()
  observeBurst()
  await flush()
  closePane()
  for (const deferred of pending.values()) {
    deferred.resolve(null)
  }
  await flush()
  expect(exactLookup).toHaveBeenCalledTimes(3)
  expect(branchLookup).not.toHaveBeenCalled()
  expect(getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0])).toHaveLength(1)
})

it('retains occupied native permits until settlement after their pane closes', async () => {
  const { store, pending, observeBurst, closePane, branchLookup, peak } = setup()
  observeBurst()
  await flush()
  closePane()
  store.getState().observeTerminalGitHubPullRequestLink(workspaceId, link(1000), context('tab-2'))
  await flush()
  expect(exactLookup).toHaveBeenCalledTimes(3)
  pending.get(100)?.resolve(null)
  await flush()
  expect(exactLookup).toHaveBeenCalledTimes(4)
  expect(exactLookup).toHaveBeenLastCalledWith(expect.objectContaining({ number: 1000 }))
  pending.get(1000)?.resolve(review(1000))
  pending.get(101)?.resolve(null)
  pending.get(102)?.resolve(null)
  await flush()
  expect(peak()).toBe(3)
  expect(branchLookup).not.toHaveBeenCalled()
  expect(
    getWorkspaceAttachments(store.getState().worktreesByRepo.repo[0]).map((item) => item.number)
  ).toEqual([7, 1000])
})

it('deduplicates an observation while queued without collapsing different PR numbers', async () => {
  const { store, pending } = setup()
  for (const number of [100, 101, 102, 103, 103, 103]) {
    store.getState().observeTerminalGitHubPullRequestLink(workspaceId, link(number), context())
  }
  await flush()
  for (const deferred of pending.values()) {
    deferred.resolve(null)
  }
  await flush()
  expect(exactLookup).toHaveBeenCalledTimes(4)
  pending.get(103)?.resolve(null)
  await flush()
  expect(exactLookup).toHaveBeenCalledTimes(4)
  expect(exactLookup.mock.calls.filter(([args]) => args.number === 103)).toHaveLength(1)
})
