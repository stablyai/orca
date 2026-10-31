// @vitest-environment happy-dom
import '../../../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { useRuntimeGraphSync } from '../app-shell/use-runtime-graph-sync'
import { getDefaultSettings } from '../../../shared/constants'
import { OrcaRuntimeService } from '../../../main/runtime/orca-runtime'
import { partialRuntimeStore } from '../../../main/runtime/runtime-store-partial-fixture'
import { registerRuntimeHandlers } from '../../../main/ipc/runtime'
import { MOBILE_PROJECT_SECTIONS_METHODS } from '../../../main/runtime/rpc/methods/mobile-project-sections'
import { getProjectSectionsResource } from '../../../../mobile/src/worktree/project-sections-resource'
import { stubRpcClient } from '../../../../mobile/src/transport/rpc-client-test-stub'
import { RpcClientRequestTracker } from '../../../../mobile/src/transport/rpc-client-request-tracker'
import { mapRuntimeError, successResponse } from '../../../main/runtime/rpc/errors'
import type { RuntimeRendererSyncWindowGraph } from '../../../shared/runtime-types'
import type * as PublisherFixture from './project-grouping-owner-publication.test-fixture'

let createProjectGroupingPublisher: typeof PublisherFixture.createProjectGroupingPublisher
beforeEach(async () => {
  vi.resetModules()
  ;({ createProjectGroupingPublisher } =
    await import('./project-grouping-owner-publication.test-fixture'))
})

vi.mock('../../../../mobile/src/i18n/mobile-i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: {
    fromWebContents: () => ({ id: 17 }),
    fromId: () => ({ isDestroyed: () => false })
  },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      ipc.handlers.set(name, handler),
    removeHandler: () => {},
    removeAllListeners: () => {},
    on: () => {}
  }
}))

it('joins successful real settings/catalog owners to graph scheduling, IPC authority, readable snapshot and distinct remote invalidation', async () => {
  vi.useFakeTimers()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useAppStore.setState(useAppStore.getInitialState(), true)
  const settings = getDefaultSettings('')
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getRepos: () => [],
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      getSettings: () => settings
    })
  )
  runtime.attachWindow(17)
  registerRuntimeHandlers(runtime)
  const frame = {}
  const event = { sender: { mainFrame: frame }, senderFrame: frame }
  const accepted: RuntimeRendererSyncWindowGraph[] = []
  const read = () => MOBILE_PROJECT_SECTIONS_METHODS[0].handler(undefined, { runtime })
  let events = 0
  let sequence = 0
  let requests = 0
  const tracker = new RpcClientRequestTracker({
    nextId: () => String(++sequence),
    getState: () => 'connected',
    waitForConnected: async () => {},
    sendFrame: (request) => {
      requests++
      void Promise.resolve()
        .then(read)
        .then(
          (result) => tracker.resolve(successResponse(request.id, { runtimeId: 'owner' }, result)),
          (error) => tracker.resolve(mapRuntimeError(request.id, { runtimeId: 'owner' }, error))
        )
      return true
    }
  })
  let leases = 0
  const client = stubRpcClient({
    sendRequest: tracker.sendRequest.bind(tracker),
    subscribe: (_method, _params, onEvent) => {
      leases++
      const stop = runtime.onClientEvent(onEvent, { consumesTerminalSideEffects: false })
      return () => {
        leases--
        stop()
      }
    }
  })
  const resource = getProjectSectionsResource(client)
  let resourceUpdates = 0
  const release = resource.subscribe(
    () => {
      resourceUpdates++
    },
    { addEventListener: () => ({ remove: () => {} }) }
  )
  const stopEvents = runtime.onClientEvent(
    (message) => {
      if (message.type === 'reposChanged') {
        events++
        expect(read()).toMatchObject({ catalog: accepted.at(-1)?.projectSectionCatalog })
      }
    },
    { consumesTerminalSideEffects: false }
  )
  const syncWindowGraph = vi.fn(async (graph: RuntimeRendererSyncWindowGraph) => {
    accepted.push(graph)
    return ipc.handlers.get('runtime:syncWindowGraph')!(event, graph)
  })
  const getSettings = vi
    .fn()
    .mockRejectedValueOnce(new Error('settings offline'))
    .mockResolvedValue(settings)
  const list = vi.fn().mockRejectedValueOnce(new Error('catalog offline')).mockResolvedValue([])
  Object.assign(window, {
    api: {
      settings: {
        get: getSettings,
        set: vi.fn(async (patch) => ({ ...useAppStore.getState().settings, ...patch }))
      },
      repos: { list },
      runtime: { syncWindowGraph },
      runtimeEnvironments: { list: async () => [] }
    }
  })
  // Session startup may finish degraded; catalog/settings readiness must come from their real successful owners.
  useAppStore.setState({ workspaceSessionReady: true })
  function Producer() {
    useRuntimeGraphSync()
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
  }
  try {
    act(() => root.render(<Producer />))
    await act(async () => {
      await useAppStore.getState().fetchSettings()
      await useAppStore.getState().fetchRepos({ runtimeEnvironmentId: null })
    })
    await settle()
    expect(read).toThrow('runtime_unavailable')
    expect(accepted.every((graph) => !graph.projectSectionCatalog)).toBe(true)
    expect(events).toBe(0)
    expect(resource.getSnapshot()).toEqual({ kind: 'pending' })
    expect(tracker.size()).toBe(0)
    expect(requests).toBe(1)
    await act(async () => {
      await useAppStore.getState().fetchSettings()
      await useAppStore.getState().fetchRepos({ runtimeEnvironmentId: null })
    })
    await settle()
    expect(accepted.at(-1)?.projectSectionCatalog).toMatchObject({ repos: [], setups: [] })
    expect(events).toBe(1)
    expect(resource.getSnapshot()).toEqual({
      kind: 'answered',
      value: accepted.at(-1)?.projectSectionCatalog
    })
    expect(resourceUpdates).toBe(1)
    expect(tracker.size()).toBe(0)
    const afterEmpty = requests
    await act(async () => {
      await useAppStore.getState().fetchRepos({ runtimeEnvironmentId: null })
    })
    await settle()
    expect(events).toBe(1)
    expect(requests).toBe(afterEmpty)
    list.mockResolvedValue([
      {
        id: 'a',
        path: '/a',
        displayName: 'App',
        badgeColor: '',
        addedAt: 0,
        upstream: { owner: 'org', repo: 'app' }
      },
      {
        id: 'b',
        path: '/b',
        displayName: 'App',
        badgeColor: '',
        addedAt: 0,
        upstream: { owner: 'org', repo: 'app' }
      }
    ])
    await act(async () => {
      await useAppStore.getState().fetchRepos({ runtimeEnvironmentId: null })
    })
    await settle()
    expect(events).toBe(2)
    expect(resource.getSnapshot()).toEqual({
      kind: 'answered',
      value: accepted.at(-1)?.projectSectionCatalog
    })
    expect(accepted.at(-1)?.projectSectionCatalog?.setups.map((setup) => setup.groupKey)).toEqual([
      'project:github:org/app',
      'project:github:org/app'
    ])
    await act(async () => {
      await useAppStore.getState().updateSettingsOrThrow({ projectGroupingMode: 'folder' })
    })
    await settle()
    expect(events).toBe(3)
    expect(
      new Set(accepted.at(-1)?.projectSectionCatalog?.setups.map((setup) => setup.groupKey)).size
    ).toBe(2)
    expect(resource.getSnapshot()).toEqual({
      kind: 'answered',
      value: accepted.at(-1)?.projectSectionCatalog
    })
    const known = read()
    expect(() =>
      ipc.handlers.get('runtime:syncWindowGraph')!({ ...event, senderFrame: {} }, accepted.at(-1))
    ).toThrow('current main frame')
    expect(read()).toEqual(known)
    expect(events).toBe(3)
    runtime.markRendererReloading(17)
    expect(read()).toEqual(known)
    runtime.markGraphReloadFailed(17, 'renderer-process-gone')
    expect(read()).toEqual(known)
  } finally {
    act(() => root.unmount())
    stopEvents()
    release()
    expect(leases).toBe(0)
    const finalRequests = requests
    runtime.notifyReposChangedForRemoteClients()
    await Promise.resolve()
    expect(requests).toBe(finalRequests)
    expect(tracker.size()).toBe(0)
    container.remove()
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.useRealTimers()
  }
})

it('releases a pending producer before a new lifetime recovers the same-client resource from real owners', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const priorApi = window.api
  try {
    for (const recover of [false, true]) {
      const publisher = createProjectGroupingPublisher(ipc.handlers)
      const resource = getProjectSectionsResource(publisher.client)
      const release = resource.subscribe(() => {}, {
        addEventListener: () => ({ remove: () => {} })
      })
      try {
        await publisher.mount()
        await act(async () => {
          await Promise.resolve()
        })
        expect(resource.getSnapshot()).toEqual({ kind: 'pending' })
        if (recover) {
          await publisher.hydrate([
            {
              id: 'same',
              path: '/local/app',
              displayName: 'App',
              badgeColor: '',
              addedAt: 0,
              upstream: { owner: 'org', repo: 'app' }
            },
            {
              id: 'same',
              path: '/server/app',
              executionHostId: 'runtime:server',
              displayName: 'App',
              badgeColor: '',
              addedAt: 0,
              upstream: { owner: 'org', repo: 'app' }
            }
          ])
          expect(resource.getSnapshot()).toMatchObject({
            kind: 'answered',
            value: { repos: [{ path: '/local/app' }, { path: '/server/app' }] }
          })
        }
      } finally {
        release()
        await publisher.dispose()
      }
      expect(window.api).toBe(priorApi)
    }
  } finally {
    vi.useRealTimers()
  }
})
