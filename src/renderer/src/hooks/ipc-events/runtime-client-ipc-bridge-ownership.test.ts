import { getDefaultSettings } from '../../../../shared/constants'
import { registerLiveTerminalSourceCompletionTests } from './runtime-client-ipc-bridge-live-completion.spec'
import { registerLateTerminalSourceRetryTest } from './runtime-client-ipc-bridge-late-terminal-source.spec'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { subscribeRuntimeEnvironmentFromPreload } from '../../../../preload/runtime-environment-subscriptions'
import { tagRuntimeSubscriptionReplayResponse } from '../../../../shared/runtime-subscription-replay'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { registerRuntimeClientIpcBridge } from './runtime-client-ipc-bridge'
import { TerminalSnapshotState } from '../../../../shared/terminal-snapshot-state'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  getTerminalSemanticResident,
  _resetTerminalSideEffectFactConsumersForTest
} from '../../components/terminal-pane/terminal-side-effect-facts-handler'
import type {
  RuntimeClientEvent,
  RuntimeClientEventStreamMessage
} from '../../../../shared/runtime-client-events'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import {
  beginWorktreeLineageRefresh,
  isRemoteWorktreeLineageFresh
} from '../../store/slices/worktrees/metadata/worktree-lineage-readiness'

const initialState = useAppStore.getState()

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  _resetTerminalSideEffectFactConsumersForTest()
  useAppStore.setState(initialState, true)
  replaceRuntimeEnvironmentRevisions(initialState.runtimeEnvironments)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

export type RuntimeClientEventBridgeHarness = ReturnType<typeof createHarness>

function createHarness() {
  type Ipc = Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[0]
  type Args = Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[1]
  type Callbacks = Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[2]
  let listener: Parameters<Ipc['on']>[1] | undefined
  const pending: ReturnType<typeof Promise.withResolvers<unknown>>[] = []
  const issueRead = Promise.withResolvers<null>()
  const ipc: Ipc = {
    invoke: vi.fn((channel) => {
      if (channel !== 'runtimeEnvironments:subscribe') {
        return Promise.resolve()
      }
      const setup = Promise.withResolvers<unknown>()
      pending.push(setup)
      return setup.promise
    }),
    send: vi.fn(),
    on: (_channel, callback) => {
      listener = callback
    },
    removeListener: vi.fn()
  }
  const getIssue = vi.fn(() => issueRead.promise)
  const refreshStatus = vi.fn(async () => true)
  const fetchRuntimeEnvironmentRepos = vi.fn(async () => [])
  let nextId = 0
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        subscribe: (args: Args, callbacks: Callbacks) =>
          subscribeRuntimeEnvironmentFromPreload(ipc, args, callbacks, () => `sub-${nextId++}`),
        call: vi.fn(async () => ({ id: 'r', ok: true, result: [] }))
      },
      browser: { sessionClientRouteImportSources: async () => ({}) },
      linear: { getIssue }
    }
  })
  const status = createCompatibleRuntimeStatusResponse()
  if (!status.ok) {
    throw new Error('expected valid runtime status fixture')
  }
  useAppStore.setState({
    settings: null,
    runtimeEnvironments: [
      {
        id: 'host-a',
        name: 'Host A',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [
          { id: 'ws-a', kind: 'websocket', label: 'WS', endpoint: 'ws://example.invalid' }
        ],
        preferredEndpointId: 'ws-a'
      }
    ],
    runtimeStatusByEnvironmentId: new Map([['host-a', { status: status.result, checkedAt: 1 }]]),
    linearIssueCache: {},
    linearSearchCache: {},
    linearListCache: {},
    linearProjectIssueCache: {},
    linearCustomViewIssueCache: {},
    checkLinearConnection: vi.fn(async () => {}),
    refreshRuntimeEnvironmentStatus: refreshStatus,
    fetchRuntimeEnvironmentRepos
  })
  const starts: (() => void)[] = []
  const activateNotifiedWorktree = vi.fn(async () => {})
  const enqueue = vi.fn()
  const start = (): (() => void) => {
    const unsubs: (() => void)[] = []
    const unsubscribeStore = registerRuntimeClientIpcBridge(unsubs, {
      worktreeChangeRefreshQueue: { enqueue, dispose: vi.fn() },
      activateNotifiedWorktree
    })
    const stop = (): void => {
      unsubscribeStore()
      unsubs.forEach((unsubscribe) => unsubscribe())
    }
    starts.push(stop)
    return stop
  }
  return {
    start,
    getIssue,
    refreshStatus,
    fetchRuntimeEnvironmentRepos,
    pending,
    ipc,
    activateNotifiedWorktree,
    enqueue,
    emit: (
      index: number,
      replay = false,
      event?:
        | RuntimeClientEventStreamMessage
        | { type: 'worktreesChanged'; repoId: string; sortOrderOnly: unknown; sortOrders?: unknown }
    ) => {
      const response = {
        id: 'r',
        ok: true as const,
        _meta: { runtimeId: 'remote-runtime' },
        result: event ?? {
          type: 'linearLinkedIssueUpdated',
          identifier: 'ISSUE-1',
          workspaceId: 'workspace-a'
        }
      }
      listener?.(null, {
        subscriptionId: `sub-${index}`,
        type: 'response',
        response: replay ? tagRuntimeSubscriptionReplayResponse(response) : response
      })
    },
    finish: async () => {
      starts.forEach((stop) => stop())
      pending.forEach((setup, index) =>
        setup.resolve({ subscriptionId: `sub-${index}`, requestId: 'r' })
      )
      issueRead.resolve(null)
      for (let index = 0; index < 30; index += 1) {
        await Promise.resolve()
      }
    }
  }
}

it('does no Linear read dispatch or cache publication after cleanup while setup is pending', async () => {
  const h = createHarness()
  let publications = 0
  const stopCounting = useAppStore.subscribe((state, previous) => {
    if (state.linearIssueCache !== previous.linearIssueCache) {
      publications += 1
    }
  })
  try {
    h.start()()
    for (let index = 0; index < 100; index += 1) {
      h.emit(0)
    }
    expect(h.getIssue).not.toHaveBeenCalled()
    expect(publications).toBe(0)
  } finally {
    stopCounting()
    await h.finish()
  }
  expect(h.ipc.removeListener).toHaveBeenCalledOnce()
})

it('does not navigate for an unaddressed activation from an older remote host', async () => {
  const h = createHarness()
  try {
    h.start()
    h.emit(0, false, { type: 'activateWorktree', repoId: 'remote-repo', worktreeId: 'remote-wt' })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }
    expect(h.activateNotifiedWorktree).not.toHaveBeenCalled()
    h.emit(0, false, { type: 'worktreesChanged', repoId: 'remote-repo' })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }
    expect(h.enqueue).toHaveBeenCalledWith({
      repoId: 'remote-repo',
      executionHostId: 'runtime:host-a'
    })
  } finally {
    await h.finish()
  }
})

it.each([true, false, undefined, 'true', 1, null])(
  'forwards only an explicit order-only host hint (%s)',
  async (sortOrderOnly) => {
    const h = createHarness()
    try {
      h.start()
      h.emit(0, false, { type: 'worktreesChanged', repoId: 'remote-repo', sortOrderOnly })
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve()
      }
      expect(h.enqueue).toHaveBeenCalledWith({
        repoId: 'remote-repo',
        executionHostId: 'runtime:host-a',
        ...(sortOrderOnly === true ? { sortOrderOnly: true } : {})
      })
    } finally {
      await h.finish()
    }
  }
)

it.each([
  { sortOrderOnly: true, valid: true, known: true, kept: true },
  { sortOrderOnly: undefined, valid: true, known: true, kept: false },
  { sortOrderOnly: true, valid: false, known: true, kept: false },
  // An unknown repo refetches so a slow discovery cannot replay older values last.
  { sortOrderOnly: true, valid: true, known: false, kept: false }
])('forwards published order values only on a valid order-only event (%o)', async (input) => {
  const h = createHarness()
  const sortOrders = input.valid
    ? [{ worktreeId: 'remote-repo::/a', sortOrder: 5 }]
    : [{ worktreeId: 'remote-repo::/a' }]
  if (input.known) {
    useAppStore.setState({
      repos: [
        {
          id: 'remote-repo',
          path: '/remote/repo',
          displayName: 'Remote repo',
          badgeColor: 'blue',
          addedAt: 1,
          executionHostId: 'runtime:host-a'
        }
      ]
    })
  }
  try {
    h.start()
    h.emit(0, false, {
      type: 'worktreesChanged',
      repoId: 'remote-repo',
      sortOrderOnly: input.sortOrderOnly,
      sortOrders
    })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }
    expect(h.enqueue).toHaveBeenCalledWith({
      repoId: 'remote-repo',
      executionHostId: 'runtime:host-a',
      ...(input.sortOrderOnly === true ? { sortOrderOnly: true } : {}),
      ...(input.kept ? { sortOrders } : {})
    })
  } finally {
    await h.finish()
  }
})

it('invalidates lineage before unknown-repository discovery can block a structural event', async () => {
  const h = createHarness()
  const repos = Promise.withResolvers<never[]>()
  h.fetchRuntimeEnvironmentRepos.mockImplementation(() => repos.promise)
  try {
    h.start()
    beginWorktreeLineageRefresh(useAppStore.getState, {
      kind: 'environment',
      environmentId: 'host-a'
    })(true)
    expect(isRemoteWorktreeLineageFresh(useAppStore.getState, 'host-a')).toBe(true)
    h.emit(0, false, { type: 'worktreesChanged', repoId: 'unknown-repo' })
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(isRemoteWorktreeLineageFresh(useAppStore.getState, 'host-a')).toBe(false)
  } finally {
    repos.resolve([])
    await h.finish()
  }
})

it('invalidates hydrated lineage as soon as a project change is queued', async () => {
  const h = createHarness()
  try {
    h.start()
    beginWorktreeLineageRefresh(useAppStore.getState, {
      kind: 'environment',
      environmentId: 'host-a'
    })(true)
    h.emit(0, false, { type: 'reposChanged' })
    expect(isRemoteWorktreeLineageFresh(useAppStore.getState, 'host-a')).toBe(false)
    expect(h.fetchRuntimeEnvironmentRepos).not.toHaveBeenCalled()
  } finally {
    await h.finish()
  }
})

it.each(['caller', 'host'] as const)(
  'ignores remote activation addressed to %s',
  async (navigation) => {
    const h = createHarness()
    try {
      h.start()
      h.emit(0, false, {
        type: 'activateWorktree',
        repoId: 'remote-repo',
        worktreeId: 'remote-wt',
        navigation
      })
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve()
      }
      expect(h.activateNotifiedWorktree).not.toHaveBeenCalled()
    } finally {
      await h.finish()
    }
  }
)

it.each(['clients', 'all'] as const)(
  'honors explicit %s activation on the publishing host',
  async (navigation) => {
    const h = createHarness()
    try {
      h.start()
      const event: RuntimeClientEvent = {
        type: 'activateWorktree',
        repoId: 'remote-repo',
        worktreeId: 'remote-wt',
        navigation
      }
      h.emit(0, false, event)
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve()
      }
      expect(h.activateNotifiedWorktree).toHaveBeenCalledWith(event, {
        allowRuntimeEnvironment: true,
        executionHostId: 'runtime:host-a',
        isCurrent: expect.any(Function)
      })
    } finally {
      await h.finish()
    }
  }
)

it('does not mistake a local repo with the same id for the publishing remote repo', async () => {
  const h = createHarness()
  useAppStore.setState({
    repos: [
      {
        id: 'same-repo',
        path: '/local/repo',
        displayName: 'Local repo',
        badgeColor: 'blue',
        addedAt: 1
      }
    ]
  })
  try {
    h.start()
    h.emit(0, false, {
      type: 'activateWorktree',
      repoId: 'same-repo',
      worktreeId: 'same-wt',
      navigation: 'clients'
    })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }
    expect(h.fetchRuntimeEnvironmentRepos).toHaveBeenCalledWith('host-a')
    expect(h.activateNotifiedWorktree).toHaveBeenCalledWith(expect.anything(), {
      allowRuntimeEnvironment: true,
      executionHostId: 'runtime:host-a',
      isCurrent: expect.any(Function)
    })
  } finally {
    await h.finish()
  }
})

it.each(['cleanup', 're-pair'] as const)(
  'cancels an accepted activation after %s during repository discovery',
  async (change) => {
    const h = createHarness()
    const repos = Promise.withResolvers<never[]>()
    h.fetchRuntimeEnvironmentRepos.mockImplementation(() => repos.promise)
    try {
      const stop = h.start()
      h.emit(0, false, {
        type: 'activateWorktree',
        repoId: 'remote-repo',
        worktreeId: 'remote-wt',
        navigation: 'clients'
      })
      expect(h.fetchRuntimeEnvironmentRepos).toHaveBeenCalledWith('host-a')
      if (change === 'cleanup') {
        stop()
      } else {
        replaceRuntimeEnvironmentRevisions([{ id: 'host-a', createdAt: 1, pairingRevision: 2 }])
      }
      repos.resolve([])
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve()
      }
      expect(h.activateNotifiedWorktree).not.toHaveBeenCalled()
    } finally {
      repos.resolve([])
      await h.finish()
    }
  }
)

it('does no replay recovery or resubscription after cleanup', async () => {
  const h = createHarness()
  try {
    h.start()()
    h.emit(0, true)
    expect(h.refreshStatus).not.toHaveBeenCalled()
    expect(h.pending).toHaveLength(1)
    expect(h.getIssue).not.toHaveBeenCalled()
  } finally {
    await h.finish()
  }
})

it('accepts a fresh bridge early frame while rejecting the previous bridge frame', async () => {
  const h = createHarness()
  try {
    h.start()()
    h.start()
    h.emit(0)
    h.emit(1)
    expect(h.getIssue).toHaveBeenCalledOnce()
    expect(h.getIssue).toHaveBeenCalledWith({ id: 'ISSUE-1', workspaceId: 'workspace-a' })
  } finally {
    await h.finish()
  }
  expect(h.ipc.removeListener).toHaveBeenCalledOnce()
})

it("lists a profile created on the host once the host announces it, without touching other hosts' lists", async () => {
  const h = createHarness()
  const madeByCli = {
    id: 'made-by-cli',
    scope: 'isolated' as const,
    partition: 'persist:orca-browser-session-made-by-cli',
    label: 'Made by CLI',
    source: null
  }
  const status = createCompatibleRuntimeStatusResponse()
  vi.mocked(window.api.runtimeEnvironments.call).mockImplementation(async ({ method }) =>
    method === 'status.get'
      ? status
      : {
          id: 'r',
          ok: true,
          result: { profiles: [madeByCli] },
          _meta: { runtimeId: 'remote-runtime' }
        }
  )
  useAppStore.setState({ browserSessionProfilesByHostId: { local: [] } })
  try {
    h.start()
    h.emit(0, false, { type: 'browserProfilesChanged' })
    await vi.waitFor(() =>
      expect(useAppStore.getState().browserSessionProfilesByHostId['runtime:host-a']).toEqual([
        madeByCli
      ])
    )
    expect(useAppStore.getState().browserSessionProfilesByHostId.local).toEqual([])
  } finally {
    await h.finish()
  }
})

it('installs a restarted runtime baseline before live effects on the same physical execution', async () => {
  const h = createHarness()
  const markTerminalBell = vi.fn()
  useAppStore.setState({ markTerminalBell })
  const source = new TerminalSnapshotState()
  const batch = (runtimeId: string) => ({
    ptyId: 'physical',
    paneKey: 'tab:leaf',
    tabId: 'tab',
    worktreeId: 'remote-wt',
    seq: 1,
    facts: [],
    terminalState: { runtimeId, incarnationId: 'incarnation', snapshot: source.snapshot() }
  })
  try {
    h.start()
    h.emit(0, false, {
      type: 'ready',
      subscriptionId: 'sub-0',
      snapshot: { terminalSideEffects: [batch('old-runtime')] }
    })
    const resident = getTerminalSemanticResident(toRemoteRuntimePtyId('physical', 'host-a'))
    expect(resident).toBeDefined()
    const policy = resident?.policy
    source.record({ kind: 'bell' }, Date.now())
    h.emit(0, false, { type: 'terminalSideEffects', batch: batch('foreign-runtime') })
    expect(markTerminalBell).not.toHaveBeenCalled()
    h.emit(0, true, {
      type: 'ready',
      subscriptionId: 'sub-0',
      snapshot: { terminalSideEffects: [batch('new-runtime')] }
    })
    expect(markTerminalBell).not.toHaveBeenCalled()
    expect(h.pending).toHaveLength(2)
    h.emit(1, false, {
      type: 'ready',
      subscriptionId: 'sub-1',
      snapshot: { terminalSideEffects: [batch('new-runtime')] }
    })
    expect(getTerminalSemanticResident(toRemoteRuntimePtyId('physical', 'host-a'))).toBe(resident)
    expect(resident?.policy).toBe(policy)
    expect(resident?.identity.runtimeId).toBe('new-runtime')
    source.record({ kind: 'bell' }, Date.now() + 1)
    h.emit(1, false, { type: 'terminalSideEffects', batch: batch('new-runtime') })
    expect(markTerminalBell).toHaveBeenCalledTimes(1)
    source.record({ kind: 'bell' }, Date.now() + 2)
    h.emit(1, false, { type: 'terminalSideEffects', batch: batch('old-runtime') })
    expect(markTerminalBell).toHaveBeenCalledTimes(1)
  } finally {
    await h.finish()
  }
})

it('R2-C3 follows actual empty-ready rollback and upgrade with stale or missing status on the same execution', async () => {
  const h = createHarness()
  const markTerminalBell = vi.fn()
  useAppStore.setState({
    markTerminalBell,
    fetchHostWorkspaceStatuses: vi.fn(async () => {}),
    settings: {
      ...getDefaultSettings('/home/test'),
      ...useAppStore.getState().settings,
      activeRuntimeEnvironmentId: 'host-a'
    }
  })
  const source = new TerminalSnapshotState()
  const ptyId = toRemoteRuntimePtyId('physical', 'host-a')
  const batch = () => ({
    ptyId: 'physical',
    paneKey: 'tab:leaf',
    tabId: 'tab',
    worktreeId: 'remote-wt',
    seq: source.state.revision,
    facts: [],
    terminalState: {
      runtimeId: 'new-runtime',
      incarnationId: 'incarnation',
      snapshot: source.snapshot()
    }
  })
  const legacy = () => ({
    type: 'terminalSideEffects' as const,
    batch: {
      ptyId: 'physical',
      paneKey: 'tab:leaf',
      tabId: 'tab',
      worktreeId: 'remote-wt',
      seq: 1,
      facts: [{ kind: 'bell' as const }]
    }
  })
  try {
    h.start()
    h.emit(0, false, {
      type: 'ready',
      subscriptionId: 'sub-0',
      snapshot: { terminalSideEffects: [batch()] }
    })
    const resident = getTerminalSemanticResident(ptyId)
    expect(resident).toBeDefined()
    const policy = resident?.policy
    const cursor = resident && Reflect.get(resident, 'consumption')
    // Store capability deliberately remains stale-capable throughout rollback.
    h.emit(0, true, { type: 'ready', subscriptionId: 'sub-0', snapshot: {} })
    expect(h.pending).toHaveLength(2)
    h.emit(1, false, { type: 'ready', subscriptionId: 'sub-1', snapshot: {} })
    h.emit(0, false, legacy())
    expect(markTerminalBell).not.toHaveBeenCalled()
    h.emit(1, false, legacy())
    expect(markTerminalBell).toHaveBeenCalledOnce()
    // Missing separately refreshed status must not suppress a current actual ready.
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/home/test'),
        ...useAppStore.getState().settings,
        activeRuntimeEnvironmentId: 'host-a'
      },
      runtimeStatusByEnvironmentId: new Map()
    })
    expect(h.pending).toHaveLength(4)
    h.emit(2, false, { type: 'ready', subscriptionId: 'sub-2', snapshot: {} })
    h.emit(2, false, legacy())
    expect(markTerminalBell).toHaveBeenCalledOnce()
    h.emit(3, false, {
      type: 'ready',
      subscriptionId: 'sub-3',
      snapshot: { terminalSideEffects: [] }
    })
    h.emit(3, false, legacy())
    expect(markTerminalBell).toHaveBeenCalledOnce()
    expect(getTerminalSemanticResident(ptyId)).toBe(resident)
    expect(Reflect.get(cursor!, 'previous')?.revision).toBe(0)
    source.record({ kind: 'bell' }, Date.now())
    h.emit(3, false, { type: 'terminalSideEffects', batch: batch() })
    expect(Reflect.get(cursor!, 'previous')?.revision).toBe(1)
    expect(markTerminalBell).toHaveBeenCalledTimes(2)
    h.emit(1, false, legacy())
    expect(markTerminalBell).toHaveBeenCalledTimes(2)
    expect(getTerminalSemanticResident(ptyId)).toBe(resident)
    expect(resident?.policy).toBe(policy)
    expect(resident && Reflect.get(resident, 'consumption')).toBe(cursor)
  } finally {
    await h.finish()
  }
})

it('R3 keeps a same-incarnation execution when restarted host state arrives after an empty capable ready', async () => {
  const h = createHarness()
  const markTerminalBell = vi.fn()
  useAppStore.setState({ markTerminalBell, fetchHostWorkspaceStatuses: vi.fn(async () => {}) })
  const source = new TerminalSnapshotState()
  const ptyId = toRemoteRuntimePtyId('physical', 'host-a')
  const { OrcaRuntimeService } = await import('../../../../main/runtime/orca-runtime')
  const runtime = new OrcaRuntimeService()
  let unsubscribe: (() => void) | undefined
  const produced: RuntimeClientEvent[] = []
  try {
    h.start()
    h.emit(0, false, {
      type: 'ready',
      subscriptionId: 'sub-0',
      snapshot: {
        terminalSideEffects: [
          {
            ptyId: 'physical',
            paneKey: 'tab:leaf',
            tabId: 'tab',
            worktreeId: 'remote-wt',
            seq: 0,
            facts: [],
            replay: true,
            terminalState: {
              runtimeId: 'old-runtime',
              incarnationId: 'incarnation',
              snapshot: source.snapshot()
            }
          }
        ]
      }
    })
    const resident = getTerminalSemanticResident(ptyId)
    expect(resident).toBeDefined()
    const cursor = resident && Reflect.get(resident, 'consumption')
    const policy = resident!.policy
    const parser = Reflect.get(policy.legacySource, 'bytes')
    const controllers = [
      policy.legacySource,
      policy.input,
      policy.completion,
      policy.notification,
      policy.foreground,
      policy.commandCode
    ]
    const restore = vi.spyOn(policy, 'restoreCurrent')
    const effects = vi.spyOn(policy, 'applyEffect')
    h.emit(0, true, { type: 'ready', subscriptionId: 'sub-0', snapshot: {} })
    expect(h.pending).toHaveLength(2)
    unsubscribe = runtime.onClientEvent(
      (event) => {
        produced.push(event)
        h.emit(1, false, event)
      },
      {
        initialize: () =>
          h.emit(1, false, {
            type: 'ready',
            subscriptionId: 'sub-1',
            snapshot: { terminalSideEffects: runtime.getTerminalSideEffectClientEventSnapshot() }
          })
      }
    )
    expect(runtime.getTerminalSideEffectClientEventSnapshot()).toEqual([])
    runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
    expect(markTerminalBell).not.toHaveBeenCalled()
    expect(effects).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledWith(expect.anything(), true, true, undefined, [])
    source.record({ kind: 'bell' }, Date.now())
    runtime.applyTerminalTransientObservation('physical', 'incarnation', source.snapshot())
    expect(produced.filter((event) => event.type === 'terminalSideEffects')).toHaveLength(2)
    expect(getTerminalSemanticResident(ptyId)).toBe(resident)
    expect(resident && Reflect.get(resident, 'consumption')).toBe(cursor)
    expect(produced[0]).toMatchObject({
      type: 'terminalSideEffects',
      batch: {
        replay: true,
        terminalState: { incarnationId: 'incarnation' }
      }
    })
    expect(produced[1]).toMatchObject({
      type: 'terminalSideEffects',
      batch: {
        terminalState: {
          incarnationId: 'incarnation',
          snapshot: { effects: { bell: { count: 1 } } }
        }
      }
    })
    expect.soft(markTerminalBell).toHaveBeenCalledOnce()
    expect(resident!.policy).toBe(policy)
    expect(Reflect.get(policy.legacySource, 'bytes')).toBe(parser)
    ;[
      policy.legacySource,
      policy.input,
      policy.completion,
      policy.notification,
      policy.foreground,
      policy.commandCode
    ].forEach((controller, index) => expect(controller).toBe(controllers[index]))
    expect(effects).toHaveBeenCalledOnce()
    // Control: the same actual producer frames deliver if only the runtime ID matches.
    for (const event of produced) {
      if (event.type === 'terminalSideEffects' && event.batch.terminalState) {
        h.emit(1, false, {
          ...event,
          batch: {
            ...event.batch,
            terminalState: {
              ...event.batch.terminalState,
              runtimeId: 'old-runtime'
            }
          }
        })
      }
    }
    expect(markTerminalBell).toHaveBeenCalledOnce()
  } finally {
    unsubscribe?.()
    runtime.onPtyExit('physical', 0)
    await h.finish()
  }
})

registerLateTerminalSourceRetryTest(createHarness)

registerLiveTerminalSourceCompletionTests(createHarness)
