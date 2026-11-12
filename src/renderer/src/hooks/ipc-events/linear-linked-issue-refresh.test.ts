import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { registerRuntimeClientIpcBridge } from './runtime-client-ipc-bridge'
import { subscribeRuntimeEnvironmentFromPreload } from '../../../../preload/runtime-environment-subscriptions'
import { linearApi } from '../../../../preload/api/linear-bridge'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { runtimeCompatibilityChecks } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { clearLinearRequestMaps } from '@/store/slices/linear/linear-slice-request-state'
import { issue, readLinearIssueForTest } from '@/store/slices/linear/linear-slice-test-harness'
import { getLinearReadScope, scopedLinearCacheKey } from '@/store/slices/linear/linear-slice-scope'
import { getWorkspaceReferenceRequest } from '@/components/sidebar/workspace-card/review/workspace-reference-details'
import type { Worktree } from '../../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../../shared/work-items/task-source-context'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearLinkedIssueUpdated } from '../../../../preload/api/linear-api'

const { localIpc } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { localIpc: new EventEmitter() }
})
vi.mock('electron', () => ({ ipcRenderer: localIpc }))
const now = 1_767_225_600_000
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
const initialState = useAppStore.getState()
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop())
  clearLinearRequestMaps()
  runtimeCompatibilityChecks.clear()
  useAppStore.setState(initialState, true)
  localIpc.removeAllListeners()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
async function settle() {
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve()
  }
}
function source(hostId: TaskSourceContext['hostId'], projectId = 'repo'): TaskSourceContext {
  return { kind: 'task-source', provider: 'linear', projectId, hostId }
}
function row(id: string, context: TaskSourceContext, workspaceId?: string): Worktree {
  return {
    id,
    repoId: 'repo',
    path: `/repo/${id}`,
    displayName: id,
    comment: '',
    hostId: context.hostId,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: 'eng-1',
    linkedLinearIssueWorkspaceId: workspaceId,
    linkedTaskSourceContext: context,
    head: 'head',
    branch: 'branch',
    isBare: false,
    isMainWorktree: false,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}
function harness(rows: Worktree[]) {
  const pending: ReturnType<typeof Promise.withResolvers<LinearIssue | null>>[] = []
  const responses: {
    host: string
    id: string
    response: ReturnType<typeof Promise.withResolvers<LinearIssue | null>>
  }[] = []
  const lists: ReturnType<typeof Promise.withResolvers<{ items: LinearIssue[] }>>[] = []
  const listIssues = vi.fn(() => {
    const response = Promise.withResolvers<{ items: LinearIssue[] }>()
    lists.push(response)
    return response.promise
  })
  const request = vi.fn((_host: string, _id: string, _workspaceId?: string) => {
    const response = Promise.withResolvers<LinearIssue | null>()
    pending.push(response)
    responses.push({ host: _host, id: _id, response })
    return response.promise
  })
  type Ipc = Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[0]
  const remoteListeners = new Map<string, Parameters<Ipc['on']>[1]>()
  const setups: { id: string; setup: ReturnType<typeof Promise.withResolvers<unknown>> }[] = []
  const subscriptions = new Map<string, string>()
  const ipc: Ipc = {
    on: (channel, fn) => {
      remoteListeners.set(channel, fn)
    },
    removeListener: (channel) => {
      remoteListeners.delete(channel)
    },
    invoke: async (_channel, args) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: subscribeRuntimeEnvironmentFromPreload supplies this transport envelope.
      const id = (args as { subscriptionId: string }).subscriptionId
      const setup = Promise.withResolvers<unknown>()
      setups.push({ id, setup })
      return setup.promise
    },
    send: vi.fn()
  }
  const status = createCompatibleRuntimeStatusResponse()
  if (!status.ok) {
    throw new Error('bad status fixture')
  }
  vi.stubGlobal('window', {
    api: {
      linear: {
        ...linearApi,
        listIssues,
        getIssue: ({ id, workspaceId }: { id: string; workspaceId?: string }) =>
          request('local', id, workspaceId)
      },
      runtimeEnvironments: {
        subscribe: (
          args: Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[1],
          callbacks: Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[2]
        ) =>
          subscribeRuntimeEnvironmentFromPreload(ipc, args, callbacks, () => {
            const id = `sub-${subscriptions.size}`
            subscriptions.set(args.selector, id)
            return id
          }),
        call: async (args: {
          selector: string
          method: string
          params: { id: string; workspaceId?: string }
        }) => ({
          id: 'r',
          ok: true,
          result:
            args.method === 'linear.getIssue'
              ? await request(args.selector, args.params.id, args.params.workspaceId)
              : args.method === 'status.get'
                ? status.result
                : []
        })
      },
      browser: { sessionClientRouteImportSources: async () => ({}) }
    }
  })
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture reads only the selected default host.
    settings: {
      ...initialState.settings,
      activeRuntimeEnvironmentId: 'host-b'
    } as AppStateSettings,
    repos: [],
    projectGroups: [],
    folderWorkspaces: [],
    worktreesByRepo: { repo: rows },
    runtimeEnvironments: ['host-a', 'host-b'].map((id) => ({
      id,
      name: 'A',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [{ id: 'ws', kind: 'websocket', label: 'WS', endpoint: 'ws://example.invalid' }],
      preferredEndpointId: 'ws'
    })),
    runtimeStatusByEnvironmentId: new Map(
      ['host-a', 'host-b'].map(
        (id): [string, { status: typeof status.result; checkedAt: number }] => [
          id,
          { status: status.result, checkedAt: now }
        ]
      )
    ),
    linearIssueCache: {},
    linearSearchCache: {},
    linearListCache: {},
    linearProjectIssueCache: {},
    linearCustomViewIssueCache: {},
    fetchRuntimeEnvironmentRepos: vi.fn(async () => []),
    fetchHostWorkspaceStatuses: vi.fn(async () => {}),
    refreshRuntimeEnvironmentStatus: vi.fn(async () => true),
    checkLinearConnection: vi.fn(async () => {})
  })
  let stop = () => {}
  const start = () => {
    const unsubs: (() => void)[] = []
    const unsubscribe = registerRuntimeClientIpcBridge(unsubs, {
      worktreeChangeRefreshQueue: { enqueue: vi.fn(), dispose: vi.fn() },
      activateNotifiedWorktree: vi.fn(async () => {})
    })
    let live = true
    stop = () => {
      if (live) {
        live = false
        unsubscribe()
        unsubs.forEach((fn) => fn())
      }
    }
    cleanups.push(stop)
  }
  const emit = (worktreeId: string, remote = false, workspaceId = 'w1') => {
    const event: LinearLinkedIssueUpdated = {
      type: 'linearLinkedIssueUpdated',
      worktreeId,
      identifier: 'ENG-1',
      workspaceId
    }
    if (remote) {
      for (const listener of remoteListeners.values()) {
        listener(null, {
          subscriptionId: subscriptions.get('host-a') ?? 'missing',
          type: 'response',
          response: { id: 'r', ok: true, result: event, _meta: { runtimeId: 'remote-runtime' } }
        })
      }
    } else {
      localIpc.emit('linear:linkedIssueUpdated', null, event)
    }
  }
  const hydrate = async (worktree: Worktree, account = 'w1') => {
    const item = {
      provider: 'linear' as const,
      type: 'issue' as const,
      number: 0,
      identifier: 'eng-1',
      linearWorkspaceId: worktree.linkedLinearIssueWorkspaceId ?? undefined
    }
    const context = getWorkspaceReferenceRequest(item, worktree).sourceContext
    const scope = getLinearReadScope(useAppStore.getState().settings, context)
    const workspaceId =
      worktree.linkedLinearIssueWorkspaceId ??
      (context?.providerIdentity?.provider === 'linear'
        ? context.providerIdentity.workspaceId
        : 'all')
    const read = readLinearIssueForTest(
      useAppStore.getState().fetchLinearIssue('eng-1', workspaceId, { sourceContext: context })
    )
    await settle()
    pending.at(-1)?.resolve({
      ...issue('eng-1'),
      workspaceId:
        worktree.linkedLinearIssueWorkspaceId ??
        (context?.providerIdentity?.provider === 'linear'
          ? (context.providerIdentity.workspaceId ?? account)
          : account)
    })
    await read
    return scopedLinearCacheKey(scope, `${workspaceId}::eng-1`)
  }
  return {
    start,
    stop: () => stop(),
    emit,
    request,
    pending,
    responses,
    lists,
    listIssues,
    hydrate,
    finishSetup: () =>
      setups.forEach(({ id, setup }) => setup.resolve({ subscriptionId: id, requestId: 'r' }))
  }
}
type AppStateSettings = NonNullable<ReturnType<typeof useAppStore.getState>['settings']>

it.each([100, 1000])(
  'coalesces two actual same-source badge keys across %i remote notices without multiplying legacy refreshes',
  async (population) => {
    const a = row('same', source('runtime:host-a'))
    const a2 = row('second', source('runtime:host-a'), 'w1')
    const local = row('same', source('local'))
    const wrongAccount = row('wrong-account', {
      ...source('runtime:host-a'),
      providerIdentity: { provider: 'linear', workspaceId: 'w2' }
    })
    const h = harness([a, a2, local, wrongAccount])
    const keys = [await h.hydrate(a), await h.hydrate(a2)]
    const localKey = await h.hydrate(local)
    const wrongKey = await h.hydrate(wrongAccount)
    h.request.mockClear()
    h.responses.length = 0
    h.start()
    for (let i = 0; i < population; i += 1) {
      h.emit('same', true)
      h.emit('second', true)
      h.emit('wrong-account', true)
    }
    await settle()
    const badgeCalls = () => h.request.mock.calls.filter((call) => call[1] === 'eng-1')
    const legacyCalls = () => h.request.mock.calls.filter((call) => call[1] === 'ENG-1')
    expect(badgeCalls()).toEqual([
      ['host-a', 'eng-1', 'all'],
      ['host-a', 'eng-1', 'w1']
    ])
    expect(legacyCalls()).toHaveLength(population === 100 ? 300 : 3000)
    expect(legacyCalls().every((call) => call[0] === 'host-b')).toBe(true)
    h.responses
      .filter((call) => call.id === 'eng-1')
      .forEach((call) => call.response.resolve(issue('eng-1')))
    await settle()
    expect(badgeCalls()).toHaveLength(4)
    h.responses.forEach((call) =>
      call.response.resolve({
        ...issue(call.id),
        workspaceId: 'w1',
        state: { name: 'Done', type: 'completed', color: '#888888' }
      })
    )
    await settle()
    expect(
      keys.map((key) => useAppStore.getState().linearIssueCache[key].data?.state.name)
    ).toEqual(['Done', 'Done'])
    expect(useAppStore.getState().linearIssueCache[localKey].data?.state.name).toBe('Todo')
    expect(useAppStore.getState().linearIssueCache[wrongKey].data?.state.name).toBe('Todo')
    expect(badgeCalls()).toHaveLength(4)
    expect(legacyCalls()).toHaveLength(population === 100 ? 300 : 3000)
    h.stop()
    h.finishSetup()
  }
)

it('tears down pending/trailing local and remote demand, rejects late setup and avoids late publication', async () => {
  const workspace = row('wt', source('local'))
  const h = harness([workspace])
  const key = await h.hydrate(workspace)
  h.request.mockClear()
  h.pending.length = 0
  h.start()
  h.emit('wt')
  h.emit('wt')
  await settle()
  h.stop()
  h.finishSetup()
  h.emit('wt')
  h.emit('wt', true)
  h.pending[0].resolve({
    ...issue('eng-1'),
    state: { name: 'Done', type: 'completed', color: '#888888' }
  })
  await settle()
  expect(h.request).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().linearIssueCache[key]?.data?.state.name).not.toBe('Done')
  expect(localIpc.listenerCount('linear:linkedIssueUpdated')).toBe(0)
})

it('preserves a pending initial badge read as demand for post-write force', async () => {
  const workspace = row('wt', source('local'))
  const h = harness([workspace])
  h.start()
  const read = readLinearIssueForTest(
    useAppStore
      .getState()
      .fetchLinearIssue('eng-1', 'all', { sourceContext: workspace.linkedTaskSourceContext })
  )
  h.emit('wt')
  await settle()
  expect(h.request).toHaveBeenCalledTimes(2)
  h.pending[0].resolve(issue('eng-1'))
  h.pending[1].resolve({
    ...issue('eng-1'),
    workspaceId: 'w1',
    state: { name: 'Done', type: 'completed', color: '#888888' }
  })
  const result = await read
  expect(result?.state.name).toBe('Done')
  await settle()
  expect(h.request).toHaveBeenCalledTimes(2)
  h.stop()
  h.finishSetup()
})
