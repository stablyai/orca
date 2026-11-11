import type { createTestStore } from '@/store/testing/app-store-test-fixture'
import type * as SnapshotRefreshModule from '@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import { beforeEach, expect, it, vi } from 'vitest'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'
import { TERMINAL_FRESH_ADMISSION_PLACEMENT_RUNTIME_CAPABILITY } from '../../../../../../shared/session-tabs-runtime-capabilities'
import type { RuntimeMobileSessionTabsResult } from '../../../../../../shared/runtime-session-contracts'

const storeRef = vi.hoisted(() => ({
  current: undefined as ReturnType<typeof createTestStore> | undefined
}))
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => storeRef.current?.getState() ?? {},
    setState: (...args: Parameters<NonNullable<typeof storeRef.current>['setState']>) =>
      storeRef.current?.setState(...args)
  }
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async (_environment: string, capability: string) =>
    capability === TERMINAL_FRESH_ADMISSION_PLACEMENT_RUNTIME_CAPABILITY
}))
let callbacks: MultiplexSubscriptionCallbacks = null
let handle = 'terminal-1'
const {
  runtimeCall,
  resetRemoteRuntimeTransport,
  subscriptionSendBinary,
  latestSubscribePayload,
  emitSnapshot,
  subscribedTerminalHandles
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => callbacks,
  setCallbacks: (value) => {
    callbacks = value
  },
  getResolvedPaneHandle: () => handle,
  setResolvedPaneHandle: (value) => {
    handle = value
  }
})
const LEAF = '11111111-1111-4111-8111-111111111111'
const refresh = vi.fn()
beforeEach(() => {
  resetRemoteRuntimeTransport()
  storeRef.current = undefined
  refresh.mockReset()
  vi.doMock('@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
    refreshWebRuntimeSessionTabsSnapshot: refresh
  }))
})

function retainedAnswer(): {
  runtimeId: string
  receivedFrame: number
  snapshot: RuntimeMobileSessionTabsResult
} {
  return {
    runtimeId: 'runtime-1',
    receivedFrame: 1,
    snapshot: {
      worktree: 'wt-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 4,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: 'terminal',
      tabs: [
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF}`,
          parentTabId: 'host-tab-1',
          leafId: LEAF,
          title: 'Terminal',
          isActive: false,
          status: 'pending-handle',
          terminal: null,
          retainedTerminalStart: {
            worktreeId: 'wt-1',
            runtimeId: 'runtime-1',
            executionHostId: 'local',
            tabId: 'host-tab-1',
            leafId: LEAF,
            bindingGeneration: 0,
            startSequence: 2,
            status: 'failed',
            reason: 'The selected shell could not start.'
          }
        }
      ]
    }
  }
}

function readyAnswer(terminal: string, incarnationId?: string) {
  const answer = retainedAnswer()
  return {
    ...answer,
    snapshot: {
      ...answer.snapshot,
      snapshotVersion: 6,
      tabs: [
        {
          type: 'terminal' as const,
          id: `host-tab-1::${LEAF}`,
          parentTabId: 'host-tab-1',
          leafId: LEAF,
          title: 'Terminal',
          isActive: false,
          status: 'ready' as const,
          terminal,
          ...(incarnationId ? { incarnationId } : {})
        }
      ]
    }
  }
}

it('reads before activating and attaches a binding published while the initial retained-start read is pending', async () => {
  const reply = Promise.withResolvers<ReturnType<typeof retainedAnswer>>()
  refresh.mockReturnValue(reply.promise)
  const original = runtimeCall.getMockImplementation()!
  runtimeCall.mockImplementation(async (request) =>
    request.method === 'terminal.resolvePane'
      ? { ok: false, error: { code: 'terminal_not_found', message: 'terminal_not_found' } }
      : original(request)
  )
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const { queueAcceptedWebSessionTerminalSnapshot } =
    await import('@/runtime/web-session-tabs-sync/terminal-handles/web-session-terminal-handle-events')
  const onPtySpawn = vi.fn()
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'web-terminal-host-tab-1',
    leafId: LEAF,
    onPtySpawn
  })
  try {
    const pending = transport.connect({ url: '', cols: 80, rows: 24, callbacks: {} })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    queueAcceptedWebSessionTerminalSnapshot(readyAnswer('terminal-2').snapshot, 'env-1')
    await Promise.resolve()
    reply.resolve(retainedAnswer())
    await expect(pending).resolves.toBeUndefined()
    expect(refresh).toHaveBeenCalledOnce()
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
      'session.tabs.activate'
    )
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
      'terminal.create'
    )
    expect(transport.isConnected()).toBe(false)
    expect(transport.ownsRecovery?.()).toBe(true)
    await vi.waitFor(() => expect(subscribedTerminalHandles()).toEqual(['terminal-2']))
    expect(onPtySpawn).not.toHaveBeenCalled()
    emitSnapshot(latestSubscribePayload().streamId, 'accepted output')
    expect(onPtySpawn).toHaveBeenCalledWith('remote:env-1@@terminal-2')
    expect(transport.isConnected()).toBe(true)
  } finally {
    transport.destroy?.()
  }
})

it.each(['dispose', 'replace-pairing'] as const)(
  'ends a held observation on %s and ignores a later accepted publication',
  async (action) => {
    const { replaceRuntimeEnvironmentRevisions } =
      await import('@/runtime/rpc/environment-revisions/runtime-environment-revision')
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1 }])
    refresh.mockResolvedValue(retainedAnswer())
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const {
      queueAcceptedWebSessionTerminalSnapshot,
      getWebSessionTerminalHandleSubscriberCountForTests
    } =
      await import('@/runtime/web-session-tabs-sync/terminal-handles/web-session-terminal-handle-events')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: LEAF
    })
    try {
      await transport.connect({ url: '', cols: 80, rows: 24, callbacks: {} })
      expect(transport.ownsRecovery?.()).toBe(true)
      if (action === 'dispose') {
        transport.detach?.()
        expect(transport.ownsRecovery?.()).toBe(false)
      } else {
        replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 2 }], {
          retired: ['env-1'],
          sameHost: []
        })
      }
      queueAcceptedWebSessionTerminalSnapshot(readyAnswer('terminal-2').snapshot, 'env-1')
      await Promise.resolve()
      expect(getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
      expect(subscribedTerminalHandles()).toEqual([])
      expect(transport.isConnected()).toBe(false)
      expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
        'session.tabs.activate'
      )
      expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
        'terminal.create'
      )
    } finally {
      transport.destroy?.()
    }
  }
)

it('keeps a held replacement fence for the old handle and accepts its proven new incarnation only on attachment', async () => {
  refresh.mockResolvedValue(readyAnswer('terminal-1', 'incarnation-1'))
  const original = runtimeCall.getMockImplementation()!
  runtimeCall.mockImplementation(async (request) => {
    const response = await original(request)
    return request.method === 'terminal.resolvePane'
      ? {
          ...response,
          result: { terminal: { ...response.result.terminal, incarnationId: 'incarnation-1' } }
        }
      : response
  })
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const { queueAcceptedWebSessionTerminalSnapshot } =
    await import('@/runtime/web-session-tabs-sync/terminal-handles/web-session-terminal-handle-events')
  const onPtyRebind = vi.fn()
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'web-terminal-host-tab-1',
    leafId: LEAF,
    onPtyRebind
  })
  try {
    transport.attach({ existingPtyId: 'remote:env-1@@terminal-1', callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    emitSnapshot(latestSubscribePayload().streamId, 'original output')
    refresh.mockResolvedValue(retainedAnswer())
    callbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: latestSubscribePayload().streamId, code: 0 }
    })
    await vi.waitFor(() => expect(transport.isConnected()).toBe(false))
    expect(transport.sendInput('held typing', 'driving')).toBe(true)
    expect(transport.hasUndeliveredInput?.()).toBe(true)
    queueAcceptedWebSessionTerminalSnapshot(
      readyAnswer('terminal-1', 'incarnation-1').snapshot,
      'env-1'
    )
    await Promise.resolve()
    expect(subscribedTerminalHandles()).toEqual(['terminal-1'])
    expect(onPtyRebind).not.toHaveBeenCalled()
    expect(transport.hasUndeliveredInput?.()).toBe(true)
    queueAcceptedWebSessionTerminalSnapshot(
      readyAnswer('terminal-1', 'incarnation-2').snapshot,
      'env-1'
    )
    await vi.waitFor(() =>
      expect(subscribedTerminalHandles()).toEqual(['terminal-1', 'terminal-1'])
    )
    expect(transport.isConnected()).toBe(false)
    expect(onPtyRebind).not.toHaveBeenCalled()
    expect(transport.hasUndeliveredInput?.()).toBe(true)
    emitSnapshot(latestSubscribePayload().streamId, 'new incarnation output')
    expect(onPtyRebind).toHaveBeenCalledWith(
      'remote:env-1@@terminal-1',
      'remote:env-1@@terminal-1',
      'incarnation-2'
    )
    expect(transport.isConnected()).toBe(true)
    expect(transport.hasUndeliveredInput?.()).toBe(false)
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
      'session.tabs.activate'
    )
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
      'terminal.create'
    )
  } finally {
    transport.destroy?.()
  }
})

it('parks on the current failed host start and attaches its later accepted successor without reactivating', async () => {
  const failed = retainedAnswer()
  refresh.mockResolvedValue({
    ...failed,
    snapshot: {
      ...failed.snapshot,
      tabs: [
        {
          ...failed.snapshot.tabs[0],
          status: 'ready',
          terminal: 'terminal-1',
          retainedTerminalStart: undefined
        }
      ]
    }
  })
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'web-terminal-host-tab-1',
    leafId: LEAF
  })
  try {
    transport.attach({ existingPtyId: 'remote:env-1@@terminal-1', callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    emitSnapshot(latestSubscribePayload().streamId, 'existing output')
    expect(transport.isConnected()).toBe(true)
    refresh.mockResolvedValue(failed)
    callbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: latestSubscribePayload().streamId, code: 0 }
    })
    await vi.waitFor(() => expect(transport.isConnected()).toBe(false))
    expect(transport.ownsRecovery?.()).toBe(true)
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
      'session.tabs.activate'
    )
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
      'terminal.create'
    )
    const { queueAcceptedWebSessionTerminalSnapshot } =
      await import('@/runtime/web-session-tabs-sync/terminal-handles/web-session-terminal-handle-events')
    queueAcceptedWebSessionTerminalSnapshot(failed.snapshot, 'env-1')
    await Promise.resolve()
    expect(subscribedTerminalHandles()).toEqual(['terminal-1'])
    queueAcceptedWebSessionTerminalSnapshot(
      {
        ...failed.snapshot,
        snapshotVersion: 5,
        tabs: [
          {
            type: 'terminal',
            id: `host-tab-1::${LEAF}`,
            parentTabId: 'host-tab-1',
            leafId: LEAF,
            title: 'Terminal',
            isActive: false,
            status: 'pending-handle',
            terminal: null,
            retainedTerminalStart: {
              worktreeId: 'wt-1',
              runtimeId: 'runtime-1',
              executionHostId: 'local',
              tabId: 'host-tab-1',
              leafId: LEAF,
              bindingGeneration: 0,
              startSequence: 3,
              status: 'starting',
              reason: ''
            }
          }
        ]
      },
      'env-1'
    )
    await Promise.resolve()
    expect(transport.isConnected()).toBe(false)
    expect(transport.ownsRecovery?.()).toBe(true)
    expect(subscribedTerminalHandles()).toEqual(['terminal-1'])
    handle = 'terminal-2'
    queueAcceptedWebSessionTerminalSnapshot(
      {
        ...failed.snapshot,
        snapshotVersion: 6,
        tabs: [
          {
            type: 'terminal',
            id: `host-tab-1::${LEAF}`,
            parentTabId: 'host-tab-1',
            leafId: LEAF,
            title: 'Terminal',
            isActive: false,
            status: 'ready',
            terminal: 'terminal-2'
          }
        ]
      },
      'env-1'
    )
    await vi.waitFor(() =>
      expect(subscribedTerminalHandles()).toEqual(['terminal-1', 'terminal-2'])
    )
    emitSnapshot(latestSubscribePayload().streamId, 'successor output')
    expect(transport.isConnected()).toBe(true)
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
      'session.tabs.activate'
    )
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
      'terminal.create'
    )
  } finally {
    transport.destroy?.()
  }
})

it.each(['starting', 'failed'] as const)(
  'transfers an accepted old-runtime %s hold through qualified pending resolution and attaches the accepted successor',
  async (status) => {
    const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
    storeRef.current = createTestStore()
    const store = storeRef.current
    const { markRuntimeEnvironmentCompatible } =
      await import('@/runtime/rpc/compatibility/runtime-compatibility-cache')
    const { refreshWebRuntimeSessionTabsSnapshot: realRefresh } = await vi.importActual<
      typeof SnapshotRefreshModule
    >('@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot')
    refresh.mockImplementation(realRefresh)
    let runtimeId = 'runtime-1'
    let legacy = false
    let snapshot = retainedAnswer().snapshot
    snapshot = {
      ...snapshot,
      tabs: snapshot.tabs.map((row) =>
        row.type === 'terminal' && row.retainedTerminalStart
          ? { ...row, retainedTerminalStart: { ...row.retainedTerminalStart, status } }
          : row
      )
    }
    const retainedSnapshot = snapshot
    snapshot = { ...readyAnswer('terminal-1', 'incarnation-1').snapshot, snapshotVersion: 3 }
    const publishStatus = () =>
      markRuntimeEnvironmentCompatible('env-1', {
        runtimeId,
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: null,
        liveTabCount: 1,
        liveLeafCount: 1,
        capabilities: legacy ? [] : [TERMINAL_FRESH_ADMISSION_PLACEMENT_RUNTIME_CAPABILITY]
      })
    publishStatus()
    const original = runtimeCall.getMockImplementation()!
    runtimeCall.mockImplementation(async (request) => {
      if (request.method === 'session.tabs.list') {
        return { ok: true, _meta: { runtimeId }, result: snapshot }
      }
      if (request.method === 'terminal.resolvePane') {
        return {
          ok: true,
          result: {
            terminal: {
              handle,
              tabId: 'host-tab-1',
              leafId: LEAF,
              worktreeId: 'wt-1',
              ptyId: null,
              connected: false
            }
          }
        }
      }
      if (request.method === 'terminal.list') {
        return { ok: true, result: { terminals: [], totalCount: 0, truncated: false } }
      }
      return original(request)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyRebind = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: LEAF,
      onPtyRebind
    })
    const paneKey = `web-terminal-host-tab-1:${LEAF}`
    try {
      transport.attach({ existingPtyId: 'remote:env-1@@terminal-1', callbacks: {} })
      await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
      emitSnapshot(latestSubscribePayload().streamId, 'original runtime image')
      snapshot = retainedSnapshot
      callbacks?.onResponse({
        ok: true,
        result: { type: 'end', streamId: latestSubscribePayload().streamId, code: 0 }
      })
      await vi.waitFor(() =>
        expect(store.getState().terminalPaneStartsByPaneKey[paneKey]?.status).toBe(status)
      )
      await vi.waitFor(() => expect(transport.isConnected()).toBe(false))
      expect(transport.sendInput('old-runtime typing', 'driving')).toBe(true)
      runtimeId = 'runtime-2'
      legacy = status === 'failed'
      publishStatus()
      snapshot = {
        ...snapshot,
        publicationEpoch: 'epoch-2',
        snapshotVersion: 1,
        tabs: [
          {
            type: 'terminal',
            id: `host-tab-1::${LEAF}`,
            parentTabId: 'host-tab-1',
            leafId: LEAF,
            title: 'Terminal',
            isActive: false,
            status: 'pending-handle',
            terminal: null
          }
        ]
      }
      if (status === 'starting') {
        const { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } =
          await import('../../../../../../shared/runtime-session-contracts')
        snapshot = { ...snapshot, publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH }
        await realRefresh('env-1', 'wt-1', { afterCurrentInFlight: true })
        expect(store.getState().terminalPaneStartsByPaneKey[paneKey]?.status).toBe('starting')
        expect(transport.isConnected()).toBe(false)
        expect(transport.ownsRecovery?.()).toBe(true)
        snapshot = { ...snapshot, publicationEpoch: 'epoch-2', snapshotVersion: 2 }
      }
      await realRefresh('env-1', 'wt-1', { afterCurrentInFlight: true })
      expect(store.getState().terminalPaneStartsByPaneKey[paneKey]).toBeUndefined()
      expect(transport.isConnected()).toBe(false)
      expect(transport.ownsRecovery?.()).toBe(true)
      expect(transport.hasUndeliveredInput?.()).toBe(true)
      expect(onPtyRebind).not.toHaveBeenCalled()
      expect(subscribedTerminalHandles()).toEqual(['terminal-1'])
      handle = 'terminal-2'
      snapshot = {
        ...readyAnswer('terminal-2', 'incarnation-2').snapshot,
        publicationEpoch: 'epoch-2',
        snapshotVersion: 3
      }
      await realRefresh('env-1', 'wt-1', { afterCurrentInFlight: true })
      await vi.waitFor(() =>
        expect(subscribedTerminalHandles()).toEqual(['terminal-1', 'terminal-2'])
      )
      expect(onPtyRebind).not.toHaveBeenCalled()
      expect(transport.hasUndeliveredInput?.()).toBe(true)
      emitSnapshot(latestSubscribePayload().streamId, 'accepted new runtime image')
      expect(onPtyRebind).toHaveBeenCalledWith(
        'remote:env-1@@terminal-2',
        'remote:env-1@@terminal-1',
        'incarnation-2'
      )
      expect(transport.isConnected()).toBe(true)
      expect(transport.hasUndeliveredInput?.()).toBe(false)
      expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
        'session.tabs.activate'
      )
      expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
        'terminal.create'
      )
    } finally {
      transport.destroy?.()
    }
  }
)

it('keeps an action hold through a pre-action in-flight omission and unqualified rows, then retires it on a genuinely post-action accepted answer', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  storeRef.current = createTestStore()
  const store = storeRef.current
  const { markRuntimeEnvironmentCompatible } =
    await import('@/runtime/rpc/compatibility/runtime-compatibility-cache')
  const { refreshWebRuntimeSessionTabsSnapshot: realRefresh } = await vi.importActual<
    typeof SnapshotRefreshModule
  >('@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot')
  const { holdRetainedTerminalStart } = await import('@/store/terminals/retained-terminal-start')
  const { applyWebSessionTabsSnapshot } =
    await import('@/runtime/web-session-tabs-sync/snapshot-api')
  const { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } =
    await import('../../../../../../shared/runtime-session-contracts')
  const status = {
    runtimeId: 'runtime-1',
    rendererGraphEpoch: 1,
    graphStatus: 'ready' as const,
    authoritativeWindowId: null,
    liveTabCount: 1,
    liveLeafCount: 1,
    capabilities: [TERMINAL_FRESH_ADMISSION_PLACEMENT_RUNTIME_CAPABILITY]
  }
  markRuntimeEnvironmentCompatible('env-1', status)
  const first = retainedAnswer().snapshot
  const pendingRow = {
    type: 'terminal' as const,
    id: `host-tab-1::${LEAF}`,
    parentTabId: 'host-tab-1',
    leafId: LEAF,
    title: 'Terminal',
    isActive: false,
    status: 'pending-handle' as const,
    terminal: null
  }
  let snapshot: RuntimeMobileSessionTabsResult = first
  let metadataRuntimeId: string | undefined = 'runtime-1'
  const original = runtimeCall.getMockImplementation()!
  const delayed = Promise.withResolvers<RuntimeMobileSessionTabsResult>()
  const started = Promise.withResolvers<void>()
  let delay = false
  runtimeCall.mockImplementation(async (request) => {
    if (request.method === 'terminal.resolvePane') {
      return {
        ok: true,
        result: {
          terminal: {
            handle: 'terminal-1',
            tabId: 'host-tab-1',
            leafId: LEAF,
            worktreeId: 'wt-1',
            ptyId: null,
            connected: false
          }
        }
      }
    }
    if (request.method === 'terminal.list') {
      return { ok: true, result: { terminals: [], totalCount: 0, truncated: false } }
    }
    if (request.method !== 'session.tabs.list') {
      return original(request)
    }
    if (delay) {
      started.resolve()
      return { ok: true, _meta: { runtimeId: metadataRuntimeId }, result: await delayed.promise }
    }
    return { ok: true, _meta: { runtimeId: metadataRuntimeId }, result: snapshot }
  })
  await realRefresh('env-1', 'wt-1')
  delay = true
  const olderRead = realRefresh('env-1', 'wt-1', { afterCurrentInFlight: true })
  await started.promise
  expect(
    holdRetainedTerminalStart(
      {
        worktreeId: 'wt-1',
        runtimeId: 'runtime-1',
        executionHostId: 'local',
        tabId: 'host-tab-1',
        leafId: LEAF,
        bindingGeneration: 0,
        startSequence: 3,
        status: 'failed',
        reason: 'The replacement shell could not start.'
      },
      {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: LEAF,
        paired: {
          environmentId: 'env-1',
          runtimeId: 'runtime-1',
          pairingRevision: undefined,
          current: () => true
        }
      }
    )
  ).toBe(true)
  const paneKey = `web-terminal-host-tab-1:${LEAF}`
  snapshot = { ...first, snapshotVersion: 5, tabs: [pendingRow] }
  delayed.resolve(snapshot)
  await olderRead
  expect(
    store.getState().terminalPaneStartsByPaneKey[paneKey]?.retainedTerminalStart?.startSequence
  ).toBe(3)
  delay = false
  // Cached data bypassing the receipt owner supplies no negative authority.
  store.setState(
    applyWebSessionTabsSnapshot(store.getState(), { ...snapshot, snapshotVersion: 99 }, 'env-1')
  )
  expect(store.getState().terminalPaneStartsByPaneKey[paneKey]?.status).toBe('failed')
  snapshot = {
    ...snapshot,
    publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
    snapshotVersion: 6
  }
  await realRefresh('env-1', 'wt-1')
  expect(store.getState().terminalPaneStartsByPaneKey[paneKey]?.status).toBe('failed')
  snapshot = {
    ...first,
    snapshotVersion: 7,
    tabs: [
      {
        ...pendingRow,
        retainedTerminalStart: {
          worktreeId: 'wt-1',
          runtimeId: 'runtime-1',
          executionHostId: 'local',
          tabId: 'host-tab-1',
          leafId: LEAF,
          bindingGeneration: 0,
          startSequence: 0,
          status: 'failed',
          reason: 'Malformed attempt'
        }
      }
    ]
  }
  await realRefresh('env-1', 'wt-1')
  expect(
    store.getState().terminalPaneStartsByPaneKey[paneKey]?.retainedTerminalStart?.startSequence
  ).toBe(3)
  snapshot = { ...first, snapshotVersion: 8, tabs: [pendingRow, { ...pendingRow }] }
  await realRefresh('env-1', 'wt-1')
  expect(store.getState().terminalPaneStartsByPaneKey[paneKey]?.status).toBe('failed')
  snapshot = { ...first, snapshotVersion: 9, tabs: [pendingRow] }
  markRuntimeEnvironmentCompatible('env-1', { ...status, capabilities: [] })
  await realRefresh('env-1', 'wt-1')
  expect(store.getState().terminalPaneStartsByPaneKey[paneKey]?.status).toBe('failed')
  markRuntimeEnvironmentCompatible('env-1', status)
  metadataRuntimeId = undefined
  snapshot = { ...snapshot, snapshotVersion: 10 }
  await realRefresh('env-1', 'wt-1')
  expect(store.getState().terminalPaneStartsByPaneKey[paneKey]?.status).toBe('failed')
  metadataRuntimeId = 'runtime-1'
  snapshot = { ...snapshot, snapshotVersion: 9 }
  await realRefresh('env-1', 'wt-1')
  expect(store.getState().terminalPaneStartsByPaneKey[paneKey]?.status).toBe('failed')
  snapshot = { ...snapshot, snapshotVersion: 11 }
  await realRefresh('env-1', 'wt-1', { afterCurrentInFlight: true })
  expect(store.getState().terminalPaneStartsByPaneKey[paneKey]).toBeUndefined()
  expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain(
    'session.tabs.activate'
  )
  expect(runtimeCall.mock.calls.map(([request]) => request.method)).not.toContain('terminal.create')
})
