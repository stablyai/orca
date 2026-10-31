import type * as RuntimeRpcClient from '../../runtime/runtime-rpc-client'
import type { WorkspacePresentationDelta } from '../../../../shared/workspace-presentation'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../index'
import {
  seed,
  assertU,
  frame,
  O,
  D,
  C1,
  C2,
  split,
  listing
} from './workspace-presentation-test-fixture'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { rawWorkspaceState, workspaceSourceWrite } from '../workspace-composition'
import { applyStructuredSessionTabSnapshots } from '../../runtime/local-structured-session-tabs-sync/snapshot-apply'
import {
  resetLocalStructuredSessionVersionForTests,
  localStructuredSessionEpochHistoryByWorktree
} from '../../runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { scheduleRetiredEpochRepair } from '../../runtime/local-structured-session-tabs-sync/retired-epoch-repair'
import { refreshLocalStructuredSessionTabs } from '../../runtime/local-structured-session-tabs-sync/inventory-refresh'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { refreshWebRuntimeSessionTabsSnapshot } from '../../runtime/web-runtime-session-snapshot'
import { buildWorkspaceSessionPayload } from '../../lib/workspace-session'
import { buildHydratedTabState } from './tabs-hydration'
import { startLocalStructuredSessionTabsSync } from '../../runtime/local-structured-session-tabs-sync/subscription'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { createTestStore } from './store-test-helpers'
import { workspaceLayoutFrameSourceStore } from '../../runtime/workspace-layout-frame-source-store'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../runtime/runtime-rpc-client', async (load) => ({
  ...(await load<typeof RuntimeRpcClient>()),
  callRuntimeRpc: vi.fn()
}))
vi.mock('../../runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../../runtime/local-runtime-capabilities', () => ({
  refreshLocalRuntimeCapabilities: vi.fn(async () => [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])
}))
createStoreSessionMockApi()
beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
  resetLocalStructuredSessionVersionForTests()
  vi.mocked(callRuntimeRpc).mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('production source ingress and settlement', () => {
  it('restores failed close through actual close dispatch and ordered host reread, retaining U', async () => {
    const store = seed()
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    const list = frame(O, 'chat1', 200)
    applyStructuredSessionTabSnapshots([list])
    vi.mocked(callRuntimeRpc)
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValue(list)
    store.getState().closeUnifiedTab(C1)
    expect(store.getState().unifiedTabsByWorktree[D].map((tab) => tab.id)).toEqual([C2])
    await vi.waitFor(() => {
      expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'session.tabs.list', {
        worktree: `id:${O}`
      })
      expect(store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)).toMatchObject({
        groupId: 'left',
        customLabel: 'Saved name'
      })
    })
    expect(store.getState().layoutByWorktree[D]).toEqual(split)
    expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O][0].worktreeId).toBe(O)
  })

  it('repairs a retired empty source through production census dispatch, parks on failure and accepts a legitimate later wake; generation teardown cancels repairs', async () => {
    vi.useFakeTimers()
    const store = seed()
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    applyStructuredSessionTabSnapshots([frame(O, 'chat1', 200)])
    applyStructuredSessionTabSnapshots([
      { ...frame(O, 'chat1', 1, false), publicationEpoch: 'headless' }
    ])
    const returning = { ...frame(O, 'chat1', 201), publicationEpoch: `epoch:${O}` }
    const census = vi
      .fn()
      .mockRejectedValueOnce(new Error('unreachable'))
      .mockResolvedValue({ ok: true, result: { snapshots: [returning], authoritative: true } })
    vi.stubGlobal('window', { api: { runtime: { call: census } } })
    const schedule = (worktree: string, epoch: string) =>
      scheduleRetiredEpochRepair(worktree, epoch, (generation) =>
        refreshLocalStructuredSessionTabs(generation, { authoritative: true })
      )
    applyStructuredSessionTabSnapshots([returning], undefined, { onRetiredEpochDrop: schedule })
    expect(localStructuredSessionEpochHistoryByWorktree.get(O)?.retired).toContain(`epoch:${O}`)
    await vi.advanceTimersByTimeAsync(250)
    expect(census).toHaveBeenCalledTimes(1)
    expect(store.getState().unifiedTabsByWorktree[D].map((tab) => tab.id)).toEqual([C2])
    // A new publisher event, rather than elapsed retry decay, wakes the parked lane.
    applyStructuredSessionTabSnapshots([returning], undefined, { onRetiredEpochDrop: schedule })
    await vi.advanceTimersByTimeAsync(500)
    expect(census).toHaveBeenCalledTimes(2)
    expect(store.getState().unifiedTabsByWorktree[D].some((tab) => tab.id === C1)).toBe(true)
    schedule(O, 'retired')
    resetLocalStructuredSessionVersionForTests()
    await vi.advanceTimersByTimeAsync(5000)
    expect(census).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('admits old-shaped paired direct replies before census, persists real source routes offline, and closes immediately in both source orders', async () => {
    for (const closeBeforeDestination of [false, true]) {
      const host = closeBeforeDestination ? 'runtime:paired-before' : 'runtime:paired-after'
      const environmentId = host.slice('runtime:'.length)
      const store = seed(host)
      vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
      const answers = new Map([
        [O, frame(O, 'chat1', 200)],
        [D, frame(D, 'chat2', 3)]
      ])
      const call = vi.fn(async (args: { method: string; params?: { worktree?: string } }) => {
        expect(args.method).toBe('session.tabs.list')
        return { ok: true, result: answers.get(args.params?.worktree?.slice(3) ?? '') }
      })
      vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, O, { errorMode: 'throw' })
      if (!closeBeforeDestination) {
        await refreshWebRuntimeSessionTabsSnapshot(environmentId, D, { errorMode: 'throw' })
      }
      assertU(store)
      const payload = buildWorkspaceSessionPayload(store.getState())
      const offline = createTestStore()
      offline.setState(
        workspaceSourceWrite({
          ...buildHydratedTabState(payload, new Set([O, D])),
          workspacePresentations: { ...store.getState().workspacePresentations }
        })
      )
      assertU(offline)
      answers.set(O, frame(O, 'chat1', 201, false))
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, O, { errorMode: 'throw' })
      expect(store.getState().unifiedTabsByWorktree[D].map((tab) => tab.id)).toEqual([C2])
      if (closeBeforeDestination) {
        await refreshWebRuntimeSessionTabsSnapshot(environmentId, D, { errorMode: 'throw' })
      }
      expect(store.getState().unifiedTabsByWorktree[D].map((tab) => tab.id)).toEqual([C2])
      expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O] ?? []).toEqual([])
      expect(call.mock.calls.every(([args]) => args.method === 'session.tabs.list')).toBe(true)
    }
  })
})

it('fences the actual pre-rename opening census, preserves other sources, and closes through the original native address', async () => {
  const store = seed()
  vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
  let deliver: (reply: unknown) => void = () => {
    throw new Error('not subscribed')
  }
  let stop = () => {}
  const old = frame(D, 'chat2', 3)
  vi.stubGlobal('window', {
    api: {
      runtime: {
        call: vi.fn(async () => ({
          ok: true,
          result: { snapshots: [frame(O, 'chat1', 200), old], authoritative: true }
        })),
        subscribe: vi.fn(async (_params: unknown, listener: (reply: unknown) => void) => {
          deliver = listener
          return { unsubscribe: vi.fn() }
        })
      }
    }
  })
  await startLocalStructuredSessionTabsSync({
    isDisposed: () => false,
    setUnsubscribe: (fn) => {
      stop = fn
    }
  })
  const N = 'r::C:/renamed'
  store.getState().migrateWorktreeIdentity(D, N)
  applyStructuredSessionTabSnapshots([frame(N, 'chat2', 4)])
  const rawO = rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O]
  const documents = store.getState().workspacePresentations
  deliver({
    ok: true,
    result: { type: 'snapshots', snapshots: [frame(O, 'chat1', 200), old], authoritative: true }
  })
  expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[D]).toBeUndefined()
  expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O]).toBe(rawO)
  expect(store.getState().workspacePresentations).toBe(documents)
  expect(
    store
      .getState()
      .unifiedTabsByWorktree[N].map((tab) => tab.id)
      .sort()
  ).toEqual([C1, C2])
  vi.mocked(callRuntimeRpc).mockResolvedValue({})
  store.getState().closeUnifiedTab(C1)
  await vi.waitFor(() =>
    expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'session.tabs.close', {
      worktree: `id:${O}`,
      tabId: 'agent-session:chat1',
      reason: 'user'
    })
  )
  expect(store.getState().unifiedTabsByWorktree[N].map((tab) => tab.id)).toEqual([C2])
  stop()
})

it('moves source-only U without a D member bucket; unknown retired live frames park after no-progress census, wake on fresh authority and tear down', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = createTestStore()
  store.setState({
    repos: seed().getState().repos,
    worktreesByRepo: { r: listing.worktrees },
    activeWorktreeId: D
  })
  vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
  let deliver: (reply: unknown) => void = () => {
    throw new Error('not subscribed')
  }
  let stop = () => {}
  const census = vi.fn(async () => ({
    ok: true,
    result: { snapshots: [frame(O, 'chat1', 200)], authoritative: true }
  }))
  vi.stubGlobal('window', {
    api: {
      runtime: {
        call: census,
        subscribe: vi.fn(async (_params: unknown, listener: (reply: unknown) => void) => {
          deliver = listener
          return { unsubscribe: vi.fn() }
        })
      }
    }
  })
  await startLocalStructuredSessionTabsSync({
    isDisposed: () => false,
    setUnsubscribe: (fn) => {
      stop = fn
    }
  })
  expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[D]).toBeUndefined()
  const before = store.getState().layoutByWorktree[D]
  const rawO = rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O]
  const N = 'r::C:/renamed'
  store.getState().migrateWorktreeIdentity(D, N)
  store.getState().migrateWorktreeIdentity(D, N)
  expect(store.getState().unifiedTabsByWorktree[N].map((tab) => tab.id)).toEqual([C1])
  expect(store.getState().layoutByWorktree[N]).toEqual(before)
  expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O]).toBe(rawO)
  const late = { ...frame(D, 'chat2', 3), publicationEpoch: 'never-observed' }
  const live = () => deliver({ ok: true, result: { ...late, type: 'updated' } })
  const initialCalls = census.mock.calls.length
  for (let i = 0; i < 5; i++) {
    live()
    await vi.advanceTimersByTimeAsync(1500)
    expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[D]).toBeUndefined()
  }
  expect(census).toHaveBeenCalledTimes(initialCalls + 3)
  await vi.advanceTimersByTimeAsync(60_001)
  expect(census).toHaveBeenCalledTimes(initialCalls + 3)
  census.mockResolvedValue({
    ok: true,
    result: { snapshots: [frame(O, 'chat1', 200), late], authoritative: true }
  })
  live()
  await vi.advanceTimersByTimeAsync(300)
  expect(
    rawWorkspaceState(store.getState()).unifiedTabsByWorktree[D]?.map((tab) => tab.entityId)
  ).toEqual(['chat2'])
  // Other addresses on the original subscription remain usable after the census fence.
  deliver({ ok: true, result: { ...frame(N, 'chat2', 5), type: 'updated' } })
  expect(
    rawWorkspaceState(store.getState()).unifiedTabsByWorktree[N]?.map((tab) => tab.entityId)
  ).toEqual(['chat2'])
  stop()
  live()
  await vi.advanceTimersByTimeAsync(5000)
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['move', 'reselect', 'withdraw'] as const)(
  'rebases failed-close restoration onto current intent (%s) during the actual ordered reread',
  async (choice) => {
    const store = seed()
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    const first = frame(O, 'chat1', 200)
    const returning = frame(O, 'chat1', 201)
    applyStructuredSessionTabSnapshots([first])
    let answerRead: (value: unknown) => void = () => {
      throw new Error('read not started')
    }
    const pendingRead = new Promise((resolve) => {
      answerRead = resolve
    })
    let ownReadStarted = false
    vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method) => {
      if (method === 'session.tabs.close') {
        throw new Error('host close refused')
      }
      if (method === 'session.tabs.list') {
        ownReadStarted = true
        return pendingRead
      }
      throw new Error(`unexpected method ${method}`)
    })
    store.getState().closeUnifiedTab(C1)
    expect(store.getState().unifiedTabsByWorktree[D].map((tab) => tab.id)).toEqual([C2])
    await vi.waitFor(() => expect(ownReadStarted).toBe(true))
    // The failed close has cleared intent; a normal live publication returns the still-live tab.
    applyStructuredSessionTabSnapshots([returning])
    expect(store.getState().unifiedTabsByWorktree[D].some((tab) => tab.id === C1)).toBe(true)
    store.getState().setTabCustomLabel(C1, 'New choice')
    const before = store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)
    expect(before?.customLabel).toBe('New choice')
    if (choice === 'move') {
      store
        .getState()
        .moveUnifiedTabToGroup(C1, 'right', { activate: true, recordInteraction: false })
    } else if (choice === 'reselect') {
      store.getState().focusGroup(D, before!.groupId)
      store.getState().activateTab(C1, { worktreeId: D })
    } else {
      applyStructuredSessionTabSnapshots([frame(O, 'chat1', 202, false)])
    }
    const chosenGroup = store
      .getState()
      .unifiedTabsByWorktree[D].find((tab) => tab.id === C1)?.groupId
    const chosen = store.getState().layoutByWorktree[D]
    answerRead(returning)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const after = store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)
    if (choice === 'withdraw') {
      expect(after).toBeUndefined()
      return
    }
    expect(after?.customLabel).toBe('New choice')
    expect(after?.groupId).toBe(chosenGroup)
    expect(store.getState().layoutByWorktree[D]).toEqual(chosen)
    expect(store.getState().activeGroupIdByWorktree[D]).toBe(chosenGroup)
  }
)

it('dispatches native sibling retirement with original source handles before accepted removal and fences late publications', async () => {
  const store = seed()
  vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
  const original = frame(O, 'chat1', 200)
  applyStructuredSessionTabSnapshots([original])
  const remove = vi.fn(async () => ({}))
  Object.assign(window.api, { ephemeralVm: { listRuntimes: vi.fn(async () => []) } })
  window.api.worktrees.remove = remove
  vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method, _params, options) => {
    options?.beforeSend?.()
    if (method !== 'session.tabs.close') {
      throw new Error(`unexpected method ${method}`)
    }
    return {}
  })
  expect(await store.getState().removeWorktree({ id: D, executionHostId: 'local' }, true)).toEqual({
    ok: true
  })
  expect(callRuntimeRpc).toHaveBeenCalledWith(
    { kind: 'local' },
    'session.tabs.close',
    { worktree: `id:${O}`, tabId: 'agent-session:chat1', reason: 'user' },
    expect.objectContaining({ beforeSend: expect.any(Function) })
  )
  expect(vi.mocked(callRuntimeRpc).mock.invocationCallOrder.at(-1)).toBeLessThan(
    remove.mock.invocationCallOrder[0]
  )
  expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O]).toBeUndefined()
  expect(Object.keys(store.getState().workspacePresentations ?? {})).toEqual([])
  applyStructuredSessionTabSnapshots([original])
  expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O]).toBeUndefined()
})

it.each([true, false])(
  'keeps an accepted genuine source-local move, read settlement succeeds=%s',
  async (succeeds) => {
    const store = seed()
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    applyStructuredSessionTabSnapshots([frame(O, 'chat1', 200)])
    let answerRead: (value: unknown) => void = () => {
      throw new Error('not started')
    }
    let rejectRead: (error: unknown) => void = () => {
      throw new Error('not started')
    }
    let started = false
    const read = new Promise((resolve, reject) => {
      answerRead = resolve
      rejectRead = reject
    })
    vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method) => {
      if (method === 'session.tabs.close') {
        throw new Error('host close refused')
      }
      if (method === 'session.tabs.list') {
        started = true
        return read
      }
      throw new Error(`unexpected ${method}`)
    })
    store.getState().closeUnifiedTab(C1)
    await vi.waitFor(() => expect(started).toBe(true))
    const returning = frame(O, 'chat1', 201)
    applyStructuredSessionTabSnapshots([returning])
    const raw = rawWorkspaceState(store.getState())
    // A genuine source-owner publication: move the live O chat into the new source-new group.
    // Membership stays O; this is the existing old-source semantic edit contract, not U mutation.
    const moved = raw.unifiedTabsByWorktree[O].map((tab) => ({ ...tab, groupId: 'source-new' }))
    workspaceLayoutFrameSourceStore(store, { kind: 'local' }, [O]).setState({
      unifiedTabsByWorktree: { ...raw.unifiedTabsByWorktree, [O]: moved },
      groupsByWorktree: {
        ...raw.groupsByWorktree,
        [O]: [{ id: 'source-new', worktreeId: O, tabOrder: [C1], activeTabId: C1 }]
      },
      layoutByWorktree: { ...raw.layoutByWorktree, [O]: { type: 'leaf', groupId: 'source-new' } },
      activeGroupIdByWorktree: { ...raw.activeGroupIdByWorktree, [O]: 'source-new' }
    })
    const accepted = store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)
    expect(accepted?.groupId).toBe('source-new')
    if (succeeds) {
      answerRead(returning)
    } else {
      rejectRead(new Error('read unavailable'))
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    const after = store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)
    expect(after?.groupId).toBe('source-new')
  }
)

it.each([
  { order: [O, D], success: undefined },
  { order: [D, O], success: undefined },
  { order: [O, D], success: O },
  { order: [D, O], success: D }
])(
  'settles overlapping native closes against pre-contraction topology ($order; success=$success)',
  async ({ order, success }) => {
    const store = seed()
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    applyStructuredSessionTabSnapshots([frame(O, 'chat1', 200), frame(D, 'chat2', 3)])
    const reads = new Map<string, (value: unknown) => void>()
    const closes = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >()
    vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method, params) => {
      if (
        !params ||
        typeof params !== 'object' ||
        !('worktree' in params) ||
        typeof params.worktree !== 'string'
      ) {
        throw new Error('missing source selector')
      }
      const id = params.worktree.slice(3)
      if (method === 'session.tabs.close') {
        return new Promise((resolve, reject) => closes.set(id, { resolve, reject }))
      }
      if (method === 'session.tabs.list') {
        return new Promise((resolve) => reads.set(id, resolve))
      }
      throw new Error(`unexpected ${method}`)
    })
    store.getState().closeUnifiedTab(C1)
    store.getState().closeUnifiedTab(C2)
    await vi.waitFor(() => expect(closes.size).toBe(2))
    for (const id of order) {
      if (id === success) {
        closes.get(id)!.resolve({})
        await new Promise((resolve) => setTimeout(resolve, 0))
      } else {
        closes.get(id)!.reject(new Error('host close refused'))
        await vi.waitFor(() => expect(reads.has(id)).toBe(true))
        reads.get(id)!(id === O ? frame(O, 'chat1', 201) : frame(D, 'chat2', 4))
        await vi.waitFor(() =>
          expect(
            store
              .getState()
              .unifiedTabsByWorktree[D]?.some((tab) => tab.id === (id === O ? C1 : C2))
          ).toBe(true)
        )
      }
    }
    const after = store.getState()
    if (!success) {
      assertU(store)
    } else {
      const remaining = success === O ? C2 : C1
      const groupId = success === O ? 'right' : 'left'
      expect(after.unifiedTabsByWorktree[D].map((tab) => tab.id)).toEqual([remaining])
      expect(after.groupsByWorktree[D].find((group) => group.id === groupId)?.tabOrder).toEqual([
        remaining
      ])
      expect(after.layoutByWorktree[D]).toEqual({ type: 'leaf', groupId })
    }
    expect(
      vi.mocked(callRuntimeRpc).mock.calls.filter(([, method]) => method === 'session.tabs.close')
    ).toHaveLength(2)
  }
)

it.each([false, true])(
  'distinguishes automatic owner mirrors from accepted main command intent during held close readback (user=%s)',
  async (user) => {
    const { workspacePresentationMirror } = await import('../workspace-presentation-mirror')
    const store = seed()
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    applyStructuredSessionTabSnapshots([frame(O, 'chat1', 200)])
    let answer: (value: unknown) => void = () => {
      throw new Error('read not started')
    }
    let started = false
    vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method) => {
      if (method === 'session.tabs.close') {
        throw new Error('host close refused')
      }
      if (method === 'session.tabs.list') {
        started = true
        return new Promise((resolve) => {
          answer = resolve
        })
      }
      throw new Error(`unexpected ${method}`)
    })
    store.getState().closeUnifiedTab(C1)
    await vi.waitFor(() => expect(started).toBe(true))
    const returning = frame(O, 'chat1', 201)
    applyStructuredSessionTabSnapshots([returning])
    let publish: (delta: WorkspacePresentationDelta) => void = () => {
      throw new Error('not subscribed')
    }
    const mirror = workspacePresentationMirror(store, (listener) => {
      publish = listener
      return () => {}
    })
    mirror.activate()
    const [key, saved] = Object.entries(store.getState().workspacePresentations!)[0]
    if (!saved || saved.layout?.type !== 'split') {
      throw new Error('missing live split')
    }
    const chosen = { ...saved.layout, ratio: 0.61 }
    publish({
      changed: {
        [key]: { ...saved, anchor: { ...saved.anchor }, layout: chosen }
      },
      removed: [],
      ...(user ? { intent: { [key]: ['layout'] } } : {})
    })
    answer(returning)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(store.getState().layoutByWorktree[D]).toEqual(user ? chosen : split)
    expect(store.getState().unifiedTabsByWorktree[D].some((tab) => tab.id === C1)).toBe(true)
    mirror.close()
  }
)
