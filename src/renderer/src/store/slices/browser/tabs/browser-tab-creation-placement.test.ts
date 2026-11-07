import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { Tab, TabGroup } from '../../../../../../shared/tab-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { createTestStore, seedStore } from '../../store-test-helpers'
import { makeTabGroup, makeUnifiedTab } from '../../store-session-test-harness'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import { createStoreCascadesMockApi } from '../../store-cascades-test-harness'
import { drawTabsFromMain, type TabsDrawnFromMain } from '../../tabs-drawn-from-main.test-fixture'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

// Main answers the window's layout commands; its frames draw the browser tabs.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt-placement'
const G1 = 'group-1'
const G2 = 'group-2'

type Store = ReturnType<typeof createTestStore>

function browserTab(id: string, groupId: string, extra: Partial<Tab> = {}): Tab {
  return makeUnifiedTab({
    id,
    worktreeId: WT,
    groupId,
    contentType: 'browser',
    entityId: `${id}-workspace`,
    lastFocusedAt: 100,
    ...extra
  })
}

/** Unpinned A B C in G1 with B active; G2 holds X and is the focused group. */
function seedSplit(store: Store, overrides: { tabs?: Tab[]; groups?: TabGroup[] } = {}): void {
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1' })] },
    activeWorktreeId: WT,
    unifiedTabsByWorktree: {
      [WT]: overrides.tabs ?? [
        browserTab('A', G1),
        browserTab('B', G1),
        browserTab('C', G1),
        browserTab('X', G2)
      ]
    },
    groupsByWorktree: {
      [WT]: overrides.groups ?? [
        makeTabGroup({
          id: G1,
          worktreeId: WT,
          activeTabId: 'B',
          tabOrder: ['A', 'B', 'C'],
          recentTabIds: ['A', 'B']
        }),
        makeTabGroup({
          id: G2,
          worktreeId: WT,
          activeTabId: 'X',
          tabOrder: ['X'],
          recentTabIds: ['X']
        })
      ]
    },
    activeGroupIdByWorktree: { [WT]: G2 },
    layoutByWorktree: {
      [WT]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: G1 },
        second: { type: 'leaf', groupId: G2 }
      }
    }
  })
}

function group(store: Store, groupId: string, worktreeId = WT): TabGroup | undefined {
  return store.getState().groupsByWorktree[worktreeId]?.find((g) => g.id === groupId)
}

function createdUnifiedId(store: Store, workspaceId: string, worktreeId = WT): string {
  const tab = store
    .getState()
    .unifiedTabsByWorktree[worktreeId]?.find((candidate) => candidate.entityId === workspaceId)
  if (!tab) {
    throw new Error(`no wrapper for ${workspaceId}`)
  }
  return tab.id
}

describe('browser tab creation placement', () => {
  let store: Store
  let main: TabsDrawnFromMain | undefined

  beforeEach(() => {
    store = createTestStore()
  })
  afterEach(() => {
    main?.close()
    main = undefined
  })

  /** Main takes the seeded layout; a layout-owner build draws the created tab from its frame. */
  async function drawFromMain(): Promise<void> {
    main?.close()
    main = await drawTabsFromMain(store)
  }
  async function settled(): Promise<void> {
    await main?.settle()
  }

  it('opens Group New Browser Tab in a new split beside the invoking group', async () => {
    seedSplit(store)
    await drawFromMain()
    await store.getState().openNewBrowserTabInActiveWorkspace(G1, 'right')
    await settled()
    const n = store
      .getState()
      .unifiedTabsByWorktree[WT]!.find((tab) => !['A', 'B', 'C', 'X'].includes(tab.id))!
    expect(group(store, G1)?.tabOrder).toEqual(['A', 'B', 'C'])
    expect(store.getState().layoutByWorktree[WT]).toMatchObject({
      first: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: G1 },
        second: { type: 'leaf', groupId: n.groupId }
      },
      second: { type: 'leaf', groupId: G2 }
    })
  })

  it('uses the invoking group workspace instead of the globally selected one', async () => {
    seedSplit(store)
    store.setState({ activeWorktreeId: 'repo1::/elsewhere' })
    await drawFromMain()
    await store.getState().openNewBrowserTabInActiveWorkspace(G1)
    await settled()
    expect(group(store, G1)?.tabOrder).toHaveLength(4)
    expect(store.getState().unifiedTabsByWorktree['repo1::/elsewhere']).toBeUndefined()
  })

  it('places a background link after its source without touching selection or MRU', async () => {
    seedSplit(store)
    const before = store.getState()
    await drawFromMain()
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com/link', { afterTabId: 'B', activate: false })
    await settled()
    const link = createdUnifiedId(store, workspace.id)
    const after = store.getState()

    expect(group(store, G1)).toMatchObject({
      tabOrder: ['A', 'B', link, 'C'],
      activeTabId: 'B',
      recentTabIds: ['A', 'B']
    })
    expect(after.activeGroupIdByWorktree[WT]).toBe(G2)
    expect(after.activeWorktreeId).toBe(WT)
    expect(after.activeTabType).toBe(before.activeTabType)
    expect(after.activeBrowserTabId).toBe(before.activeBrowserTabId)
    expect(after.unifiedTabsByWorktree[WT]!.find((tab) => tab.id === link)?.lastFocusedAt).toBe(
      undefined
    )
    expect(after.unifiedTabsByWorktree[WT]!.find((tab) => tab.id === 'B')?.lastFocusedAt).toBe(100)
  })

  it('lets an explicit destination win over the anchor group', async () => {
    seedSplit(store)
    await drawFromMain()
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { afterTabId: 'B', targetGroupId: G2 })
    await settled()
    expect(group(store, G2)?.tabOrder).toEqual(['X', createdUnifiedId(store, workspace.id)])
    expect(group(store, G1)?.tabOrder).toEqual(['A', 'B', 'C'])
  })

  it('falls back to the active group, not the first group, for an expired requested group', async () => {
    seedSplit(store)
    await drawFromMain()
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { targetGroupId: 'deleted-group' })
    await settled()
    expect(group(store, G2)?.tabOrder).toEqual(['X', createdUnifiedId(store, workspace.id)])
  })

  it('keeps an unpinned tab from a pinned source after the pinned prefix', async () => {
    seedSplit(store, {
      tabs: [
        browserTab('P1', G1, { isPinned: true }),
        browserTab('P2', G1, { isPinned: true }),
        browserTab('C', G1),
        browserTab('X', G2)
      ],
      groups: [
        makeTabGroup({ id: G1, worktreeId: WT, activeTabId: 'P1', tabOrder: ['P1', 'P2', 'C'] }),
        makeTabGroup({ id: G2, worktreeId: WT, activeTabId: 'X', tabOrder: ['X'] })
      ]
    })
    await drawFromMain()
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { afterTabId: 'P1' })
    await settled()
    expect(group(store, G1)?.tabOrder).toEqual([
      'P1',
      'P2',
      createdUnifiedId(store, workspace.id),
      'C'
    ])
  })

  it('appends in the partition when preview replacement removes the anchor', () => {
    seedSplit(store, {
      tabs: [
        browserTab('A', G1, { sortOrder: 0 }),
        makeUnifiedTab({
          id: 'P',
          worktreeId: WT,
          groupId: G1,
          contentType: 'editor',
          isPreview: true,
          sortOrder: 1
        }),
        browserTab('C', G1, { sortOrder: 2 }),
        browserTab('X', G2)
      ],
      groups: [
        makeTabGroup({ id: G1, worktreeId: WT, activeTabId: 'P', tabOrder: ['A', 'P', 'C'] }),
        makeTabGroup({ id: G2, worktreeId: WT, activeTabId: 'X', tabOrder: ['X'] })
      ]
    })
    const created = store
      .getState()
      .createUnifiedTab(WT, 'editor', { afterTabId: 'P', isPreview: true, targetGroupId: G1 })
    expect(group(store, G1)?.tabOrder).toEqual(['A', 'C', created.id])
    expect(created.sortOrder).toBe(2)
    const sortOrderById = Object.fromEntries(
      store.getState().unifiedTabsByWorktree[WT]!.map((tab) => [tab.id, tab.sortOrder])
    )
    expect(sortOrderById).toMatchObject({ A: 0, C: 1, [created.id]: 2 })
  })

  it('rejects an anchor owned by a foreign execution host', async () => {
    seedSplit(store, {
      tabs: [browserTab('A', G1, { executionHostId: 'ssh:other' }), browserTab('X', G2)],
      groups: [
        makeTabGroup({ id: G1, worktreeId: WT, activeTabId: 'A', tabOrder: ['A'] }),
        makeTabGroup({ id: G2, worktreeId: WT, activeTabId: 'X', tabOrder: ['X'] })
      ]
    })
    await drawFromMain()
    const workspace = store.getState().createBrowserTab(WT, 'https://example.com', {
      afterTabId: 'A',
      executionHostId: 'runtime:env-1'
    })
    await settled()
    expect(group(store, G2)?.tabOrder).toEqual(['X', createdUnifiedId(store, workspace.id)])
  })

  it('accepts an SSH-backed anchor through the worktree runtime-owner alias', async () => {
    const sshHost: ExecutionHostId = 'ssh:target-1'
    seedSplit(store, {
      tabs: [browserTab('A', G1, { executionHostId: sshHost }), browserTab('C', G1)],
      groups: [makeTabGroup({ id: G1, worktreeId: WT, activeTabId: 'A', tabOrder: ['A', 'C'] })]
    })
    store.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WT,
            repoId: 'repo1',
            hostId: sshHost,
            runtimeOwnerEnvironmentId: 'env-1'
          })
        ]
      }
    })
    await drawFromMain()
    const workspace = store.getState().createBrowserTab(WT, 'https://example.com', {
      afterTabId: 'A',
      executionHostId: 'runtime:env-1'
    })
    await settled()
    expect(group(store, G1)?.tabOrder).toEqual(['A', createdUnifiedId(store, workspace.id), 'C'])
  })

  it('places source actions in folder and floating workspaces', async () => {
    const folderWt = 'folder:folder-1'
    const folder: FolderWorkspace = {
      id: 'folder-1',
      projectGroupId: 'pg',
      name: 'Folder',
      folderPath: '/tmp/folder',
      executionHostId: 'local',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    for (const worktreeId of [folderWt, FLOATING_TERMINAL_WORKTREE_ID]) {
      store.setState({
        folderWorkspaces: [folder],
        unifiedTabsByWorktree: {
          ...store.getState().unifiedTabsByWorktree,
          [worktreeId]: ['A', 'B'].map((id) =>
            makeUnifiedTab({
              id: `${worktreeId}-${id}`,
              worktreeId,
              groupId: `${worktreeId}-g`,
              contentType: 'browser'
            })
          )
        },
        groupsByWorktree: {
          ...store.getState().groupsByWorktree,
          [worktreeId]: [
            makeTabGroup({
              id: `${worktreeId}-g`,
              worktreeId,
              activeTabId: `${worktreeId}-A`,
              tabOrder: [`${worktreeId}-A`, `${worktreeId}-B`]
            })
          ]
        }
      })
      await drawFromMain()
      const workspace = store.getState().createBrowserTab(worktreeId, 'https://example.com', {
        afterTabId: `${worktreeId}-A`,
        browserRuntimeEnvironmentId: null
      })
      await settled()
      expect(group(store, `${worktreeId}-g`, worktreeId)?.tabOrder).toEqual([
        `${worktreeId}-A`,
        createdUnifiedId(store, workspace.id, worktreeId),
        `${worktreeId}-B`
      ])
    }
  })
})
