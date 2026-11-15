import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import type { Tab, TabGroup } from '../../../../../../shared/tab-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../../tabs/tab-group.test-fixture'
import { makeWorktree } from '../../worktrees/worktree.test-fixture'
import { createStoreCascadesMockApi } from '../../../testing/app-store-cascade-api.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../tabs/tabs-drawn-from-main.test-fixture'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

// Main answers the window's layout commands; its frames draw the browser tabs.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
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
})
