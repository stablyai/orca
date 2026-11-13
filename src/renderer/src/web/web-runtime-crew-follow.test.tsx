// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  type RuntimeEnvironmentStatus,
  runtimeEnvironmentStatusFromSnapshot
} from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'
import type * as RuntimeSession from './preload-api/web-runtime-session'
import type { PreloadApi } from '../../../preload/api-types'
import { replaceRuntimeEnvironmentRevisions } from '../runtime/rpc/environment-revisions/runtime-environment-revision'
import { useOrchestrationCrew } from '../components/orchestration-crew/use-orchestration-crew'
import {
  type CrewSocket,
  flushCrewWork,
  installCrewSocketGlobals,
  latestCrewSocket,
  publicKeyB64,
  verifyCrewPrimary
} from './web-runtime-crew.test-fixture'

const store = vi.hoisted(() => ({
  state: { runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>() },
  listeners: new Set<() => void>()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store.state,
    subscribe: (wake: () => void) => {
      store.listeners.add(wake)
      return () => store.listeners.delete(wake)
    }
  }
}))
const environment: StoredWebRuntimeEnvironment = {
  id: 'host',
  name: 'Host',
  createdAt: 1,
  updatedAt: 1,
  pairingRevision: 1,
  runtimeId: 'rt',
  lastUsedAt: null,
  preferredEndpointId: 'endpoint',
  endpoints: [
    {
      id: 'endpoint',
      kind: 'websocket',
      label: 'WebSocket',
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'token',
      publicKeyB64
    }
  ]
}
const target = { kind: 'environment', environmentId: 'host' } as const
let session: typeof RuntimeSession
let api: PreloadApi['runtimeEnvironments']
let disposeStatus: () => void
const domWindow = window
function Pane({ party = 'term_one' }: { party?: string }) {
  const crew = useOrchestrationCrew(target, party)
  return (
    <output data-testid={party}>
      {crew.status === 'ok' ? crew.sections.managing.length : 'unknown'}
    </output>
  )
}
function requestId(socket: CrewSocket): string {
  const request = socket.read(2)
  if (
    !request ||
    typeof request !== 'object' ||
    !('id' in request) ||
    typeof request.id !== 'string' ||
    !('method' in request) ||
    request.method !== 'orchestration.crewSubscribe'
  ) {
    throw new Error('Expected actual Crew subscribe request')
  }
  return request.id
}
async function ready(socket = latestCrewSocket()): Promise<string> {
  socket.open()
  socket.ready()
  await flushCrewWork()
  socket.authenticated()
  await flushCrewWork()
  return requestId(socket)
}
function frame(socket: CrewSocket, id: string, result: unknown, runtimeId = 'rt'): void {
  socket.frame({ id, ok: true, result, _meta: { runtimeId } })
}
async function complete(socket: CrewSocket, id: string, runtimeId = 'rt'): Promise<void> {
  frame(socket, id, { type: 'begin', status: 'ok' }, runtimeId)
  frame(
    socket,
    id,
    {
      type: 'rows',
      section: 'managing',
      rows: [
        {
          partyKey: 'worker',
          role: 'worker',
          label: 'Worker',
          agentKind: 'codex',
          status: 'working'
        }
      ]
    },
    runtimeId
  )
  frame(socket, id, { type: 'complete' }, runtimeId)
  await flushCrewWork()
}
beforeEach(async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  installCrewSocketGlobals()
  vi.stubGlobal('window', domWindow)
  localStorage.clear()
  localStorage.setItem('orca.web.runtimeEnvironment.v1', JSON.stringify(environment))
  session = await import('./preload-api/web-runtime-session')
  session.manuallyDisconnectedEnvironmentIds.clear()
  session.webRuntimeState.activeEnvironment = environment
  api = (await import('./preload-api/web-runtime-environments-api')).createRuntimeEnvironmentsApi()
  Object.assign(window, { api: { runtimeEnvironments: api } })
  store.state = { runtimeStatusByEnvironmentId: new Map() }
  disposeStatus = session.subscribeWebRuntimeStatus((snapshot) => {
    store.state = {
      runtimeStatusByEnvironmentId: new Map(store.state.runtimeStatusByEnvironmentId).set(
        'host',
        runtimeEnvironmentStatusFromSnapshot(snapshot)
      )
    }
    store.listeners.forEach((wake) => wake())
  })
  replaceRuntimeEnvironmentRevisions([{ id: 'host', createdAt: 1 }])
  await verifyCrewPrimary(session.getClientForEnvironment(environment))
})
afterEach(() => {
  cleanup()

  disposeStatus()
  session.closeActiveRuntimeClients()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('retires the old source and follows the real verified runtime publication after its writer completes', async () => {
  const ordinary = vi.spyOn(api, 'subscribe')
  const retry = vi.spyOn(api, 'subscribeCrewAttempt')
  const view = render(<Pane />)
  const first = latestCrewSocket()
  let oldId = ''
  await act(async () => {
    oldId = await ready(first)
    await complete(first, oldId)
    const owner = session.webRuntimeState.activeClient!.statusOwner!
    owner.acceptVerified({
      id: 'status',
      ok: true,
      result: { ...owner.read().status!, runtimeId: 'next' },
      _meta: { runtimeId: 'next' }
    })
    await complete(first, oldId)
  })
  expect(view.getByTestId('term_one').textContent).toBe('unknown')
  expect(retry).not.toHaveBeenCalled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(retry).toHaveBeenCalledOnce()
  expect(retry.mock.calls[0][0].expectedEnvironmentRuntimeId).toBe('next')
  const current = latestCrewSocket()
  await act(async () => {
    const id = await ready(current)
    await complete(current, id, 'next')
  })
  expect(view.getByTestId('term_one').textContent).toBe('1')
  expect(ordinary).toHaveBeenCalledOnce()
  view.unmount()
})
