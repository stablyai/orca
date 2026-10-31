import '../../../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, vi } from 'vitest'
import { useAppStore } from '../store'
import { useRuntimeGraphSync } from '../app-shell/use-runtime-graph-sync'
import { getDefaultSettings } from '../../../shared/constants'
import { OrcaRuntimeService } from '../../../main/runtime/orca-runtime'
import { partialRuntimeStore } from '../../../main/runtime/runtime-store-partial-fixture'
import { registerRuntimeHandlers } from '../../../main/ipc/runtime'
import { MOBILE_PROJECT_SECTIONS_METHODS } from '../../../main/runtime/rpc/methods/mobile-project-sections'
import { MOBILE_PROJECT_SECTIONS_METHOD } from '../../../shared/mobile-project-sections-contract'
import { stubRpcClient } from '../../../../mobile/src/transport/rpc-client-test-stub'
import { RpcClientRequestTracker } from '../../../../mobile/src/transport/rpc-client-request-tracker'
import { mapRuntimeError, successResponse } from '../../../main/runtime/rpc/errors'
import type { RpcRequestFrame } from '../../../../mobile/src/transport/rpc-envelope-fields'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeRendererSyncWindowGraph } from '../../../shared/runtime-types'

export function createProjectGroupingPublisher(
  handlers: ReadonlyMap<string, (...args: unknown[]) => unknown>,
  otherRequest: (request: RpcRequestFrame) => unknown = () => ({}),
  onCheckpoint: (phase: string, snapshot: unknown) => void = () => {}
) {
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
  let sequence = 0
  let leases = 0
  const frames: RpcRequestFrame[] = []
  const tracker = new RpcClientRequestTracker({
    nextId: () => String(++sequence),
    getState: () => 'connected',
    waitForConnected: async () => {},
    sendFrame: (request) => {
      frames.push(request)
      void Promise.resolve()
        .then(() =>
          request.method === MOBILE_PROJECT_SECTIONS_METHOD ? read() : otherRequest(request)
        )
        .then(
          (result) => tracker.resolve(successResponse(request.id, { runtimeId: 'owner' }, result)),
          (error) => tracker.resolve(mapRuntimeError(request.id, { runtimeId: 'owner' }, error))
        )
      return true
    }
  })
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
  const getSettings = vi
    .fn()
    .mockRejectedValueOnce(new Error('settings offline'))
    .mockResolvedValue(settings)
  const list = vi.fn().mockRejectedValueOnce(new Error('catalog offline')).mockResolvedValue([])
  const priorApi = window.api
  Object.assign(window, {
    api: {
      settings: { get: getSettings },
      repos: { list },
      runtimeEnvironments: { list: async () => [] },
      runtime: {
        syncWindowGraph: async (graph: RuntimeRendererSyncWindowGraph) => {
          accepted.push(graph)
          return handlers.get('runtime:syncWindowGraph')!(event, graph)
        }
      }
    }
  })
  // Degraded session readiness is deliberately insufficient to publish membership.
  useAppStore.setState({ workspaceSessionReady: true })
  function Producer() {
    useRuntimeGraphSync()
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
  const checkpoint = (phase: string) => {
    let ownerRead: unknown
    try {
      ownerRead = read()
    } catch (error) {
      ownerRead = error instanceof Error ? error.message : String(error)
    }
    const state = useAppStore.getState()
    onCheckpoint(phase, {
      ownerRead,
      settingsHydrated: state.projectGroupingSettingsHydrated,
      reposHydrated: state.localRepoCatalogHydrated,
      settingsRequests: getSettings.mock.calls.length,
      catalogRequests: list.mock.calls.length,
      accepted: accepted.length,
      pendingRequests: tracker.size()
    })
  }
  return {
    client,
    runtime,
    tracker,
    frames,
    accepted,
    read,
    mount: async () => {
      checkpoint('publisher mounting')
      await act(async () => root.render(<Producer />))
      checkpoint('publisher mounted')
      await act(async () => {
        await useAppStore.getState().fetchSettings()
        await useAppStore.getState().fetchRepos({ runtimeEnvironmentId: null })
      })
      checkpoint('failed owners fetched')
      await settle()
      checkpoint('failed owners settled')
      expect(read).toThrow('runtime_unavailable')
    },
    hydrate: async (repos: readonly Repo[]) => {
      checkpoint('owner hydration starting')
      list.mockResolvedValue(repos)
      await act(async () => {
        await useAppStore.getState().fetchSettings()
        await useAppStore.getState().fetchRepos({ runtimeEnvironmentId: null })
      })
      await settle()
      checkpoint('owner hydration settled')
      expect(read()).toMatchObject({ catalog: accepted.at(-1)?.projectSectionCatalog })
    },
    dispose: async () => {
      try {
        await act(async () => root.unmount())
        checkpoint('publisher unmounted')
      } finally {
        container.remove()
        Object.assign(window, { api: priorApi })
        useAppStore.setState(useAppStore.getInitialState(), true)
      }
      expect(leases).toBe(0)
      expect(tracker.size()).toBe(0)
    }
  }
}
