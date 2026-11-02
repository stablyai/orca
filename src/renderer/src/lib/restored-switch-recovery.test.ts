// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

// A restart after a terminal→chat switch committed main's chat record (naming tab T) but before
// the window saved T holding the chat: the first authoritative inventory puts the chat in the
// restored T, once. No other frame changes a tab: not a stale one, not a later live one.

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: vi.fn(() => Promise.resolve())
}))

const { createTabsSliceMockApi } = await import('@/store/slices/tabs-slice-test-harness')
createTabsSliceMockApi()
const { createTestStore, makeTab, makeTabGroup, makeUnifiedTab, makeWorktree, seedStore } =
  await import('@/store/slices/store-test-helpers')
const store = createTestStore()
vi.mock('@/store', () => ({ useAppStore: store }))

const { captureRestoredSwitchCandidates, resetRestoredSwitchCandidatesForTests } =
  await import('./restored-switch-recovery')
const { applyStructuredSessionTabSnapshots } =
  await import('@/runtime/local-structured-session-tabs-sync/snapshot-apply')
const { resetLocalStructuredSessionVersionForTests } =
  await import('@/runtime/local-structured-session-tabs-sync/inventory-generation-fence')
const { resetWebSessionTabsSnapshotFreshnessForTests } =
  await import('@/runtime/web-session-tabs-sync/tracking-lifecycle')

const WORKTREE = 'repo-1::/tmp/wt-restore'
const GROUP = 'group-1'

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetRestoredSwitchCandidatesForTests()
})

/** Restores `ids` as terminal tabs (the first pinned), as a load's hydration does. */
function restore(ids: string[], live: Record<string, string[]> = {}): void {
  seedStore(store, {
    activeWorktreeId: WORKTREE,
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WORKTREE, repoId: 'repo-1', path: '/tmp/wt-restore' })]
    },
    tabsByWorktree: { [WORKTREE]: ids.map((id) => makeTab({ id, worktreeId: WORKTREE })) },
    unifiedTabsByWorktree: {
      [WORKTREE]: ids.map((id, index) =>
        makeUnifiedTab({
          id,
          entityId: id,
          groupId: GROUP,
          worktreeId: WORKTREE,
          contentType: 'terminal',
          ...(index === 0 ? { isPinned: true } : {})
        })
      )
    },
    groupsByWorktree: {
      [WORKTREE]: [makeTabGroup({ id: GROUP, worktreeId: WORKTREE, tabOrder: ids })]
    },
    layoutByWorktree: { [WORKTREE]: { type: 'leaf', groupId: GROUP } },
    activeGroupIdByWorktree: { [WORKTREE]: GROUP },
    ptyIdsByTabId: live,
    terminalLayoutsByTabId: {},
    openFiles: [],
    browserTabsByWorktree: {}
  })
  captureRestoredSwitchCandidates(store.getState().unifiedTabsByWorktree)
}

/** Main's inventory: chat `session-<tab>` recorded in each named tab. */
const inventory = (tabIds: string[], snapshotVersion = 1): RuntimeMobileSessionTabsResult => ({
  worktree: WORKTREE,
  publicationEpoch: 'main',
  snapshotVersion,
  activeGroupId: GROUP,
  activeTabId: null,
  activeTabType: null,
  tabs: tabIds.map((tabId) => ({
    type: 'agent-session' as const,
    id: `agent-session:session-${tabId}`,
    title: 'Codex',
    sessionId: `session-${tabId}`,
    agent: 'codex' as const,
    isActive: false,
    logicalTabId: tabId
  })),
  tabGroups: [
    {
      id: GROUP,
      activeTabId: null,
      tabOrder: tabIds.map((tabId) => `agent-session:session-${tabId}`)
    }
  ]
})

const tab = (id: string) =>
  store.getState().unifiedTabsByWorktree[WORKTREE]?.find((entry) => entry.id === id)
const chats = () =>
  (store.getState().unifiedTabsByWorktree[WORKTREE] ?? []).filter(
    (entry) => entry.contentType === 'agent-session'
  )

it('puts the recorded chat in its restored tab on the first authoritative inventory, once', () => {
  restore(['T', 'other'])
  // A stream frame before the inventory changes no tab and leaves the candidate for it.
  applyStructuredSessionTabSnapshots([inventory(['T'])])
  expect(tab('T')?.contentType).toBe('terminal')
  applyStructuredSessionTabSnapshots([inventory(['T'], 2)], undefined, { authoritative: true })
  expect(tab('T')).toMatchObject({
    contentType: 'agent-session',
    entityId: 'session-T',
    isPinned: true
  })
  expect(chats()).toHaveLength(1)
  expect(store.getState().groupsByWorktree[WORKTREE]?.[0]?.tabOrder).toEqual(['T', 'other'])
  expect(store.getState().tabsByWorktree[WORKTREE]?.map((entry) => entry.id)).toEqual(['other'])
})

it.each([
  // Its terminal runs this run: a newer switch's CLI, never the stale half of a crashed one.
  ['holds a running terminal', { T: ['pty-live'] }, false],
  // A live switch or close since the restore: never a candidate (the live misfire case).
  ['changed content after the restore', {}, true]
] as const)('leaves a restored tab that %s', (_name, live, changed) => {
  restore(['T'], live)
  if (changed) {
    store.setState({
      unifiedTabsByWorktree: {
        [WORKTREE]: [{ ...tab('T')!, entityId: 'E' }]
      }
    })
  }
  applyStructuredSessionTabSnapshots([inventory(['T'])], undefined, { authoritative: true })
  expect(tab('T')?.contentType).toBe('terminal')
})

it('never recovers from a later frame, stale or current', () => {
  restore(['T'])
  // The load's inventory lists no chat in T: recovery is spent.
  applyStructuredSessionTabSnapshots(
    [{ ...inventory([], 2), tabs: [], tabGroups: [] }],
    undefined,
    {
      authoritative: true
    }
  )
  // A stale frame (rejected by version) and a current one naming T both leave it a terminal.
  applyStructuredSessionTabSnapshots([inventory(['T'], 1)], undefined, { authoritative: true })
  applyStructuredSessionTabSnapshots([inventory(['T'], 3)], undefined, { authoritative: true })
  expect(tab('T')?.contentType).toBe('terminal')
})

it.each([
  ['ordinary chats', false],
  ['recovered tabs', true]
])('costs linear work in its inventory for %s', (_name, recovering) => {
  // Reads of the restored tabs' ids through the real frame trigger, at N and 10N.
  const reads = (count: number): number => {
    const ids = Array.from({ length: count }, (_, index) => `tab-${index}`)
    restore(ids)
    let read = 0
    const counted = (store.getState().unifiedTabsByWorktree[WORKTREE] ?? []).map((entry) => {
      // Ordinary chats already hold their chats; the restored candidates stay but don't match.
      const copy = recovering
        ? { ...entry }
        : {
            ...entry,
            contentType: 'agent-session' as const,
            entityId: `session-${entry.id}`,
            agentSessionAgent: 'codex' as const
          }
      Object.defineProperty(copy, 'id', {
        enumerable: true,
        get: () => {
          read++
          return entry.id
        }
      })
      return copy
    })
    store.setState({ unifiedTabsByWorktree: { [WORKTREE]: counted } })
    read = 0
    applyStructuredSessionTabSnapshots([inventory(ids)], undefined, { authoritative: true })
    resetLocalStructuredSessionVersionForTests()
    resetWebSessionTabsSnapshotFreshnessForTests()
    return read
  }
  const small = reads(20)
  expect(reads(200)).toBeLessThanOrEqual(12 * small)
})
