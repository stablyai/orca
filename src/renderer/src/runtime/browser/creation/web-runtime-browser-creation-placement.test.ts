import { applyWebSessionTabsSnapshot } from '../../web-session-tabs-sync/snapshot-api'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SnapshotModule from '../../web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import { useAppStore } from '../../../store/index'
import { createWebRuntimeSessionBrowserTab } from './web-runtime-browser-creation'
import { resetWebSessionBrowserPlacementsForTests } from '../placement/web-session-browser-placement'
import {
  makeSnapshot,
  NOW,
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

  it('never selects a floating page as the source workspace browser fallback', async () => {
    const opening = openLinkFromSource({ placementWorkspaceId: FLOATING_TERMINAL_WORKTREE_ID })
    const pageId = pendingCreates[0].params.page!
    pendingCreates[0].resolve()
    await opening
    const snapshot = makeSnapshot(
      [
        {
          id: 'host-floating',
          browserWorkspaceId: `host-workspace-${pageId}`,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          type: 'browser',
          title: 'Floating page',
          browserPageId: pageId,
          url: 'https://example.com/',
          isActive: true
        }
      ],
      { snapshotVersion: 100, activeTabType: 'browser', activeTabId: 'host-floating' }
    )
    useAppStore.setState({ activeBrowserTabIdByWorktree: { [WT]: null } })
    useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW + 100))
    expect(useAppStore.getState().activeBrowserTabIdByWorktree[WT]).toBeNull()
    const floatingView =
      useAppStore.getState().unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
    expect(floatingView).toMatchObject({ worktreeId: 'global-floating-terminal' })
    expect(
      (useAppStore.getState().unifiedTabsByWorktree[WT] ?? []).some(
        (tab) => tab.id === floatingView?.id
      )
    ).toBe(false)
  })

  it('places a remote page in floating while snapshots retain its original host and workspace', async () => {
    const floating = FLOATING_TERMINAL_WORKTREE_ID
    const before = useAppStore.getState().unifiedTabsByWorktree[WT]!.map((tab) => tab.id)
    const opening = openLinkFromSource({
      placementWorkspaceId: floating,
      clientAfterTabId: undefined
    })
    const pageId = pendingCreates[0].params.page!
    const staged = Object.values(useAppStore.getState().unifiedTabsByWorktree)
      .flat()
      .find((tab) =>
        (useAppStore.getState().browserPagesByWorkspace[tab.entityId] ?? []).some(
          (page) => page.id === pageId
        )
      )
    expect(staged).toMatchObject({
      worktreeId: 'global-floating-terminal',
      executionHostId: 'local'
    })
    pendingCreates[0].resolve()
    await expect(opening).resolves.toBe(true)
    publishHostSnapshot()
    const state = useAppStore.getState()
    expect(state.unifiedTabsByWorktree[WT]!.map((tab) => tab.id)).toEqual(before)
    expect(state.unifiedTabsByWorktree[floating]).toEqual([
      expect.objectContaining({ id: staged!.id })
    ])
    expect(state.remoteBrowserPageHandlesByPageId[pageId]).toMatchObject({
      environmentId: ENV,
      remotePageId: pageId
    })
    expect(state.remoteBrowserPageHandlesByPageId[pageId]?.staged).toBeUndefined()
    expect(state.browserPagesByWorkspace[staged!.entityId]).toEqual([
      expect.objectContaining({ worktreeId: WT, browserRuntimeEnvironmentId: ENV })
    ])
    hostPages.splice(0)
    publishHostSnapshot()
    expect(useAppStore.getState().unifiedTabsByWorktree[floating] ?? []).toEqual([])
    expect(useAppStore.getState().groupsByWorktree[floating]?.[0]?.tabOrder ?? []).toEqual([])
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
