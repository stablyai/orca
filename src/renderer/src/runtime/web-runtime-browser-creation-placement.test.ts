import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SnapshotModule from './web-runtime-session-snapshot'
import { useAppStore } from '../store'
import { createWebRuntimeSessionBrowserTab } from './web-runtime-browser-creation'
import { resetWebSessionBrowserPlacementsForTests } from './web-session-browser-placement'
import { resetWebSessionTabsSyncTestState, ENV, WT } from './web-session-tabs-sync-test-harness'
import {
  AFTER,
  G1,
  G2,
  HOST,
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
} from './web-runtime-browser-creation-placement-test-rig'

vi.mock('./web-runtime-session-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotModule>()),
  refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => publishHostSnapshot())
}))

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
  let runtimeCall: ReturnType<typeof installRuntimeTransport>

  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    resetWebSessionBrowserPlacementsForTests()
    resetHostPages()
    seedPairedWorktree()
    runtimeCall = installRuntimeTransport()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stages each background link after its source before any await and keeps source, 3, 2, 1', async () => {
    const creates = [openLinkFromSource(), openLinkFromSource(), openLinkFromSource()]
    const staged = pendingCreates.map((create) => create.params.page ?? '')
    // Why no await above: the rows exist off the synchronous part of each call.
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

  it('keeps the host-facing RPC free of the client anchor', async () => {
    void openLinkFromSource({ targetGroupId: 'host-group' })
    expect(pendingCreates[0].params).not.toHaveProperty('clientAfterTabId')
    expect(pendingCreates[0].params).not.toHaveProperty('afterTabId')
    expect(pendingCreates[0].params).toMatchObject({
      targetGroupId: 'host-group',
      activate: false,
      navigation: 'caller'
    })
    // A host-facing group never freezes the anchored staged row out of the source's group.
    expect(groupOrder(G1)[1]).toBe(wrapperForRemotePage(pendingCreates[0].params.page!)?.id)
    expect(wrapperForRemotePage(pendingCreates[0].params.page!)?.executionHostId).toBe(HOST)
    pendingCreates[0].resolve()
    await flushMicrotasks()
    expect(runtimeCall).toHaveBeenCalledTimes(1)
  })

  it('appends Group New Browser Tab staging to the invoking group without an anchor', async () => {
    const create = createWebRuntimeSessionBrowserTab({
      worktreeId: WT,
      environmentId: ENV,
      url: 'about:blank',
      targetGroupId: G1,
      clientTargetGroupId: G1,
      placementPreference: 'server'
    })
    const pageId = pendingCreates[0].params.page!
    const created = wrapperForRemotePage(pageId)!.id
    expect(groupOrder(G1)).toEqual([SOURCE.unifiedTabId, AFTER.unifiedTabId, created])
    expect(useAppStore.getState().activeGroupIdByWorktree[WT]).toBe(G1)
    pendingCreates[0].resolve()
    await expect(create).resolves.toBe(true)
    expect(groupOrder(G1)).toEqual([SOURCE.unifiedTabId, AFTER.unifiedTabId, created])
  })

  it('stages the store Group New Browser Tab command before its first await', async () => {
    useAppStore.setState({
      browserDefaultUrl: 'about:blank',
      repos: [
        {
          id: 'repo',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: '#000000',
          addedAt: 1,
          connectionId: null,
          executionHostId: HOST
        }
      ],
      worktreesByRepo: {
        repo: [
          {
            id: WT,
            repoId: 'repo',
            path: '/worktree',
            head: 'abc',
            branch: 'main',
            isBare: false,
            isMainWorktree: false,
            displayName: 'Worktree',
            comment: '',
            linkedIssue: null,
            linkedPR: null,
            linkedLinearIssue: null,
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 1
          }
        ]
      }
    })
    const open = useAppStore.getState().openNewBrowserTabInActiveWorkspace(G1)
    const order = groupOrder(G1)
    expect(order.slice(0, 2)).toEqual([SOURCE.unifiedTabId, AFTER.unifiedTabId])
    expect(order).toHaveLength(3)
    const created = order[2]
    await flushMicrotasks()
    expect(pendingCreates[0].params).toMatchObject({ targetGroupId: G1 })
    expect(wrapperForRemotePage(pendingCreates[0].params.page!)?.id).toBe(created)
    pendingCreates[0].resolve()
    await open
    expect(groupOrder(G1)).toEqual([SOURCE.unifiedTabId, AFTER.unifiedTabId, created])
  })

  it('fills an empty group structurally without adoption recording a visit', async () => {
    const state = useAppStore.getState()
    useAppStore.setState({
      groupsByWorktree: {
        [WT]: [
          ...state.groupsByWorktree[WT]!,
          { id: 'group-3', worktreeId: WT, activeTabId: null, tabOrder: [], recentTabIds: [] }
        ]
      },
      layoutByWorktree: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          first: state.layoutByWorktree[WT]!,
          second: { type: 'leaf', groupId: 'group-3' }
        }
      }
    })
    const create = createWebRuntimeSessionBrowserTab({
      worktreeId: WT,
      environmentId: ENV,
      url: 'https://example.com/',
      clientTargetGroupId: 'group-3',
      focusOnCreate: false,
      selectWorktree: false,
      placementPreference: 'server'
    })
    const created = wrapperForRemotePage(pendingCreates[0].params.page!)!.id
    pendingCreates[0].resolve()
    await expect(create).resolves.toBe(true)
    publishHostSnapshot()
    expect(
      useAppStore.getState().groupsByWorktree[WT]?.find((group) => group.id === 'group-3')
    ).toMatchObject({ activeTabId: created, tabOrder: [created], recentTabIds: [] })
    expect(useAppStore.getState().activeGroupIdByWorktree[WT]).toBe(G2)
  })

  it('keeps a staged row the user dragged elsewhere through adoption', async () => {
    const create = openLinkFromSource()
    const pageId = pendingCreates[0].params.page!
    const staged = wrapperForRemotePage(pageId)!.id
    useAppStore.getState().moveUnifiedTabToGroup(staged, G2)
    pendingCreates[0].resolve()
    await expect(create).resolves.toBe(true)
    expect(groupOrder(G2)).toContain(staged)
    expect(groupOrder(G1)).toEqual([SOURCE.unifiedTabId, AFTER.unifiedTabId])
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

  it('stages before a deferred hosting preparation resolves', async () => {
    let answerPreparation!: (placement: { kind: 'server' }) => void
    const prepare = vi.fn(
      () =>
        new Promise<{ kind: 'server' }>((resolve) => {
          answerPreparation = resolve
        })
    )
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeCall, prepareBrowserClientHostPlacement: prepare }
      }
    })
    const create = openLinkFromSource({ placementPreference: 'auto' })
    const stagedRows = groupOrder(G1)
    expect(stagedRows).toHaveLength(3)
    useAppStore.getState().focusGroup(WT, G2)
    await flushMicrotasks()
    answerPreparation({ kind: 'server' })
    await flushMicrotasks()
    pendingCreates[0].resolve()
    await expect(create).resolves.toBe(true)
    expect(groupOrder(G1)).toEqual(stagedRows)
    expect(useAppStore.getState().activeGroupIdByWorktree[WT]).toBe(G2)
  })

  it('rehomes a staged row in place when an older host answers with its own id first', async () => {
    useAppStore.setState({
      runtimeStatusByEnvironmentId: runtimeStatusesFor(['browser.screencast.v1'])
    })
    const create = openLinkFromSource()
    const staged = groupOrder(G1)[1]
    expect(pendingCreates[0].params.page).toBeUndefined()
    pendingCreates[0].resolve('host-minted-page')
    await expect(create).resolves.toBe(true)
    expect(groupOrder(G1)).toEqual([SOURCE.unifiedTabId, staged, AFTER.unifiedTabId])
    expect(wrapperForRemotePage('host-minted-page')?.id).toBe(staged)
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

  it('falls back to ordinary adoption without adjacency when staging fails', async () => {
    const createBrowserTab = useAppStore.getState().createBrowserTab
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useAppStore.setState({
      createBrowserTab: () => {
        throw new Error('staging refused')
      }
    })
    try {
      const create = openLinkFromSource()
      expect(groupOrder(G1)).toEqual([SOURCE.unifiedTabId, AFTER.unifiedTabId])
      useAppStore.setState({ createBrowserTab })
      pendingCreates[0].resolve()
      await expect(create).resolves.toBe(true)
      const adopted = wrapperForRemotePage(pendingCreates[0].params.page!)
      expect(adopted).toBeDefined()
      expect(
        useAppStore.getState().unifiedTabsByWorktree[WT]!.filter((tab) => tab.id === adopted!.id)
      ).toHaveLength(1)
      expect(groupOrder(G1).indexOf(adopted!.id)).not.toBe(1)
    } finally {
      warn.mockRestore()
    }
  })
})
