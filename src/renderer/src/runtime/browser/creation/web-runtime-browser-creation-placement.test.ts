import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SnapshotModule from '../../web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import { useAppStore } from '../../../store/index'
import { createWebRuntimeSessionBrowserTab } from './web-runtime-browser-creation'
import { resetWebSessionBrowserPlacementsForTests } from '../placement/web-session-browser-placement'
import {
  resetWebSessionTabsSyncTestState,
  ENV,
  WT
} from '../../web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
import {
  AFTER,
  G1,
  G2,
  OTHER,
  SOURCE,
  flushMicrotasks,
  groupOrder,
  hostPages,
  installRuntimeTransport,
  pendingCreates,
  publishHostSnapshot,
  resetHostPages,
  runtimeStatusesFor,
  seedPairedWorktree,
  wrapperForRemotePage
} from './testing/web-runtime-browser-creation-placement-test-rig'

vi.mock(
  '../../web-session-tabs-sync/inventory/web-runtime-session-snapshot',
  async (importOriginal) => ({
    ...(await importOriginal<typeof SnapshotModule>()),
    refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => publishHostSnapshot())
  })
)

function openLinkFromSource(
  overrides: Partial<Parameters<typeof createWebRuntimeSessionBrowserTab>[0]> = {}
): Promise<boolean> {
  return createWebRuntimeSessionBrowserTab({
    worktreeId: WT,
    environmentId: ENV,
    url: 'https://example.com/link',
    clientAfterTabId: SOURCE.unifiedTabId,
    focusOnCreate: false,
    selectWorktree: false,
    placementPreference: 'server',
    ...overrides
  })
}

function g1Group() {
  return useAppStore.getState().groupsByWorktree[WT]?.find((group) => group.id === G1)
}

describe('paired browser creation placement', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    resetWebSessionBrowserPlacementsForTests()
    resetHostPages()
    seedPairedWorktree()
    installRuntimeTransport()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stages each background link after its source before any await and keeps source, 3, 2, 1', async () => {
    const creates = [openLinkFromSource(), openLinkFromSource(), openLinkFromSource()]
    const staged = pendingCreates.map((create) => create.params.page ?? '')
    // Rows must exist synchronously, before either call is awaited.
    const stagedIds = staged.map((pageId) => wrapperForRemotePage(pageId)!.id)
    expect(groupOrder(G1)).toEqual([
      SOURCE.unifiedTabId,
      stagedIds[2],
      stagedIds[1],
      stagedIds[0],
      AFTER.unifiedTabId
    ])

    for (const index of [2, 0, 1]) {
      pendingCreates[index].resolve()
      await flushMicrotasks()
    }
    await expect(Promise.all(creates)).resolves.toEqual([true, true, true])

    expect(groupOrder(G1)).toEqual([
      SOURCE.unifiedTabId,
      stagedIds[2],
      stagedIds[1],
      stagedIds[0],
      AFTER.unifiedTabId
    ])
    for (const pageId of staged) {
      expect(wrapperForRemotePage(pageId)?.lastFocusedAt).toBeUndefined()
    }
    const state = useAppStore.getState()
    expect(g1Group()).toMatchObject({
      activeTabId: SOURCE.unifiedTabId,
      recentTabIds: [SOURCE.unifiedTabId]
    })
    expect(state.activeGroupIdByWorktree[WT]).toBe(G2)
    expect(state.activeBrowserTabIdByWorktree[WT]).toBe(OTHER.workspaceId)
    expect(
      state.unifiedTabsByWorktree[WT]?.find((tab) => tab.id === SOURCE.unifiedTabId)?.lastFocusedAt
    ).toBeDefined()
    // Repeated snapshots neither replay the anchor nor manufacture visits.
    publishHostSnapshot()
    expect(groupOrder(G1)[1]).toBe(stagedIds[2])
    expect(g1Group()?.recentTabIds).toEqual([SOURCE.unifiedTabId])
  })

  it('does not reclaim focus after the user selects another tab mid-create', async () => {
    const create = openLinkFromSource({ focusOnCreate: true })
    const staged = wrapperForRemotePage(pendingCreates[0].params.page!)!.id
    expect(g1Group()?.activeTabId).toBe(staged)
    useAppStore.getState().activateTab(OTHER.unifiedTabId)
    useAppStore.getState().activateTab(SOURCE.unifiedTabId)
    pendingCreates[0].resolve()
    await expect(create).resolves.toBe(true)
    publishHostSnapshot()
    expect(g1Group()?.activeTabId).toBe(SOURCE.unifiedTabId)
    expect(useAppStore.getState().activeWorktreeId).toBe(WT)
  })

  it('keeps the mirrored row and discards the stage when an older host mirrors first', async () => {
    useAppStore.setState({
      runtimeStatusByEnvironmentId: runtimeStatusesFor(['browser.screencast.v1'])
    })
    const create = openLinkFromSource()
    const staged = groupOrder(G1)[1]
    hostPages.push('host-minted-page')
    publishHostSnapshot()
    hostPages.pop()
    pendingCreates[0].resolve('host-minted-page')
    await expect(create).resolves.toBe(true)
    const mirrored = wrapperForRemotePage('host-minted-page')!
    const browserRows = useAppStore
      .getState()
      .unifiedTabsByWorktree[WT]!.filter((tab) => tab.contentType === 'browser')
    expect(browserRows).toHaveLength(4)
    expect(mirrored.id).not.toBe(staged)
    expect(groupOrder(G1)).not.toContain(staged)
    // Compatibility limit: exact adjacency is not replayed onto the mirrored row.
    publishHostSnapshot()
    expect(useAppStore.getState().unifiedTabsByWorktree[WT]).toHaveLength(4)
  })
})
