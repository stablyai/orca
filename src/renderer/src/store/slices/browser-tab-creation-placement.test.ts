import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  createTestStore,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

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

  beforeEach(() => {
    store = createTestStore()
  })

  it('appends Group New Browser Tab regardless of the active tab', async () => {
    seedSplit(store)
    await store.getState().openNewBrowserTabInActiveWorkspace(G1)
    const n = store.getState().unifiedTabsByWorktree[WT]!.at(-1)!
    expect(group(store, G1)?.tabOrder).toEqual(['A', 'B', 'C', n.id])

    store.getState().activateTab('A')
    await store.getState().openNewBrowserTabInActiveWorkspace(G1)
    const m = store.getState().unifiedTabsByWorktree[WT]!.at(-1)!
    expect(group(store, G1)?.tabOrder).toEqual(['A', 'B', 'C', n.id, m.id])
  })

  it('uses the invoking group workspace instead of the globally selected one', async () => {
    seedSplit(store)
    store.setState({ activeWorktreeId: 'repo1::/elsewhere' })
    await store.getState().openNewBrowserTabInActiveWorkspace(G1)
    expect(group(store, G1)?.tabOrder).toHaveLength(4)
    expect(store.getState().unifiedTabsByWorktree['repo1::/elsewhere']).toBeUndefined()
  })

  it('records desktop placement for both normal and profile tabs on an SSH workspace', async () => {
    seedSplit(store)
    store.setState({
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WT, repoId: 'repo1', hostId: 'ssh:target' })]
      }
    })
    await store.getState().openNewBrowserTabInActiveWorkspace(G1)
    await store.getState().openBrowserProfileTabInActiveWorkspace('https://example.com', null)
    const workspaces = store.getState().browserTabsByWorktree[WT] ?? []
    expect(workspaces).toHaveLength(2)
    for (const workspace of workspaces) {
      expect(
        store.getState().browserPagesByWorkspace[workspace.id]?.[0]?.browserRuntimeEnvironmentId
      ).toBeNull()
    }
  })

  it('places a duplicate directly after its source', () => {
    seedSplit(store)
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { afterTabId: 'B' })
    const duplicate = createdUnifiedId(store, workspace.id)
    expect(group(store, G1)?.tabOrder).toEqual(['A', 'B', duplicate, 'C'])
    expect(
      store
        .getState()
        .unifiedTabsByWorktree[WT]!.filter((tab) => tab.groupId === G1)
        .map((tab) => [tab.id, tab.sortOrder])
    ).toEqual([
      ['A', 0],
      ['B', 1],
      ['C', 3],
      [duplicate, 2]
    ])
  })

  it('places a background link after its source without touching selection or MRU', () => {
    seedSplit(store)
    const before = store.getState()
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com/link', { afterTabId: 'B', activate: false })
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

  it('focuses the resolved group for a foreground source action in an unfocused split', () => {
    seedSplit(store)
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { afterTabId: 'B' })
    const created = createdUnifiedId(store, workspace.id)
    const state = store.getState()
    expect(state.activeGroupIdByWorktree[WT]).toBe(G1)
    expect(group(store, G1)).toMatchObject({ activeTabId: created })
    expect(group(store, G1)?.recentTabIds).toEqual(['A', 'B', created])
    expect(state.activeBrowserTabId).toBe(workspace.id)
    expect(state.activeTabType).toBe('browser')
  })

  it('lets an explicit destination win over the anchor group', () => {
    seedSplit(store)
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { afterTabId: 'B', targetGroupId: G2 })
    expect(group(store, G2)?.tabOrder).toEqual(['X', createdUnifiedId(store, workspace.id)])
    expect(group(store, G1)?.tabOrder).toEqual(['A', 'B', 'C'])
  })

  it('treats a closed anchor as absent and appends in the active group', () => {
    seedSplit(store)
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { afterTabId: 'closed-tab' })
    expect(group(store, G2)?.tabOrder).toEqual(['X', createdUnifiedId(store, workspace.id)])
  })

  it('falls back to the active group, not the first group, for an expired requested group', () => {
    seedSplit(store)
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { targetGroupId: 'deleted-group' })
    expect(group(store, G2)?.tabOrder).toEqual(['X', createdUnifiedId(store, workspace.id)])
  })

  it('ignores an ambiguous anchor id', () => {
    seedSplit(store, {
      tabs: [browserTab('A', G1), browserTab('B', G1), browserTab('B', G2), browserTab('C', G1)]
    })
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { afterTabId: 'B' })
    expect(group(store, G2)?.tabOrder).toEqual(['X', createdUnifiedId(store, workspace.id)])
  })

  it('ignores an anchor whose group order no longer contains it', () => {
    seedSplit(store, {
      groups: [
        makeTabGroup({ id: G1, worktreeId: WT, activeTabId: 'A', tabOrder: ['A', 'C'] }),
        makeTabGroup({ id: G2, worktreeId: WT, activeTabId: 'X', tabOrder: ['X'] })
      ]
    })
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { afterTabId: 'B' })
    expect(group(store, G2)?.tabOrder).toEqual(['X', createdUnifiedId(store, workspace.id)])
  })

  it('collapses duplicate order entries while inserting once', () => {
    seedSplit(store, {
      groups: [
        makeTabGroup({ id: G1, worktreeId: WT, activeTabId: 'B', tabOrder: ['A', 'B', 'A', 'C'] }),
        makeTabGroup({ id: G2, worktreeId: WT, activeTabId: 'X', tabOrder: ['X'] })
      ]
    })
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { afterTabId: 'B' })
    expect(group(store, G1)?.tabOrder).toEqual([
      'A',
      'B',
      createdUnifiedId(store, workspace.id),
      'C'
    ])
  })

  it('keeps an unpinned tab from a pinned source after the pinned prefix', () => {
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
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { afterTabId: 'P1' })
    expect(group(store, G1)?.tabOrder).toEqual([
      'P1',
      'P2',
      createdUnifiedId(store, workspace.id),
      'C'
    ])
  })

  it('keeps a pinned candidate before the unpinned suffix and beside a pinned anchor', () => {
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
    const fromUnpinned = store
      .getState()
      .createUnifiedTab(WT, 'editor', { afterTabId: 'C', isPinned: true })
    expect(group(store, G1)?.tabOrder).toEqual(['P1', 'P2', fromUnpinned.id, 'C'])
    const fromPinned = store
      .getState()
      .createUnifiedTab(WT, 'editor', { afterTabId: 'P1', isPinned: true })
    expect(group(store, G1)?.tabOrder).toEqual(['P1', fromPinned.id, 'P2', fromUnpinned.id, 'C'])
    expect(fromPinned.sortOrder).toBe(1)
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

  it('leaves the wrapper host unset instead of stamping a substituted routing host', () => {
    seedSplit(store)
    // Why: no repo row and a focused runtime make the routing resolver substitute runtime:env-1.
    store.setState({
      activeWorktreeId: 'repo1::/elsewhere',
      settings: { ...store.getState().settings!, activeRuntimeEnvironmentId: 'env-1' }
    })
    const workspace = store.getState().createBrowserTab(WT, 'https://example.com', {
      activate: false,
      browserRuntimeEnvironmentId: null
    })
    const wrapper = store
      .getState()
      .unifiedTabsByWorktree[WT]!.find((tab) => tab.entityId === workspace.id)
    expect(wrapper).toBeDefined()
    expect(wrapper?.executionHostId).toBeUndefined()
  })

  it('rejects an anchor owned by a foreign execution host', () => {
    seedSplit(store, {
      tabs: [browserTab('A', G1, { executionHostId: 'ssh:other' }), browserTab('X', G2)],
      groups: [
        makeTabGroup({ id: G1, worktreeId: WT, activeTabId: 'A', tabOrder: ['A'] }),
        makeTabGroup({ id: G2, worktreeId: WT, activeTabId: 'X', tabOrder: ['X'] })
      ]
    })
    const workspace = store.getState().createBrowserTab(WT, 'https://example.com', {
      afterTabId: 'A',
      executionHostId: 'runtime:env-1'
    })
    expect(group(store, G2)?.tabOrder).toEqual(['X', createdUnifiedId(store, workspace.id)])
  })

  it('accepts an SSH-backed anchor through the worktree runtime-owner alias', () => {
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
    const workspace = store.getState().createBrowserTab(WT, 'https://example.com', {
      afterTabId: 'A',
      executionHostId: 'runtime:env-1'
    })
    expect(group(store, G1)?.tabOrder).toEqual(['A', createdUnifiedId(store, workspace.id), 'C'])
  })

  it('places source actions in folder and floating workspaces', () => {
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
            makeUnifiedTab({ id: `${worktreeId}-${id}`, worktreeId, groupId: `${worktreeId}-g` })
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
      const workspace = store.getState().createBrowserTab(worktreeId, 'https://example.com', {
        afterTabId: `${worktreeId}-A`,
        browserRuntimeEnvironmentId: null
      })
      expect(group(store, `${worktreeId}-g`, worktreeId)?.tabOrder).toEqual([
        `${worktreeId}-A`,
        createdUnifiedId(store, workspace.id, worktreeId),
        `${worktreeId}-B`
      ])
    }
  })

  it('selects the first tab of an empty group structurally without recording a visit', () => {
    seedSplit(store, {
      groups: [
        makeTabGroup({ id: G1, worktreeId: WT, activeTabId: null, tabOrder: [], recentTabIds: [] }),
        makeTabGroup({ id: G2, worktreeId: WT, activeTabId: 'X', tabOrder: ['X'] })
      ],
      tabs: [browserTab('X', G2)]
    })
    const workspace = store
      .getState()
      .createBrowserTab(WT, 'https://example.com', { targetGroupId: G1, activate: false })
    const created = createdUnifiedId(store, workspace.id)
    expect(group(store, G1)).toMatchObject({ activeTabId: created, recentTabIds: [] })
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(G2)
  })
})
