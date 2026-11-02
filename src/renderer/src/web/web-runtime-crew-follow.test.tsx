// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../shared/runtime-host-status'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'
import type * as RuntimeSession from './preload-api/web-runtime-session'
import type { PreloadApi } from '../../../preload/api-types'
import { replaceRuntimeEnvironmentRevisions } from '../runtime/runtime-environment-revision'
import { useOrchestrationCrew } from '../components/native-chat/use-orchestration-crew'
import { SharedControlReconnectScheduler } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-reconnect'
import {
  CrewSocket,
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
  expect(store.listeners.size).toBe(0)
  disposeStatus()
  session.closeActiveRuntimeClients()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each(['end', 'close'] as const)(
  'follows actual %s loss through scheduler, finite adapter, transport settlement and complete Crew',
  async (loss) => {
    const ordinary = vi.spyOn(api, 'subscribe')
    const retry = vi.spyOn(api, 'subscribeCrewAttempt')
    const scheduler = vi.spyOn(
      SharedControlReconnectScheduler.prototype,
      'scheduleWithDefaultBackoff'
    )
    const view = render(
      <>
        <Pane />
        <Pane party="term_one" />
      </>
    )
    const first = latestCrewSocket()
    let id = ''
    await act(async () => {
      id = await ready(first)
      await complete(first, id)
    })
    expect(ordinary).toHaveBeenCalledOnce()
    expect(view.getAllByTestId('term_one').map((node) => node.textContent)).toEqual(['1', '1'])
    await act(async () => {
      frame(first, id, { type: 'begin', status: 'ok' })
      if (loss === 'end') {
        frame(first, id, { type: 'end' })
      }
      if (loss === 'close') {
        first.onclose?.()
      }
      await flushCrewWork()
    })
    if (loss === 'end') {
      expect(first.close).toHaveBeenCalledOnce()
    }
    expect(view.getAllByTestId('term_one')[0].textContent).toBe('unknown')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(retry).toHaveBeenCalledOnce()
    expect(ordinary).toHaveBeenCalledOnce()
    const second = latestCrewSocket()
    await act(async () => {
      id = await ready(second)
    })
    expect(retry.mock.calls[0][0]).toMatchObject({
      expectedEnvironmentRuntimeId: 'rt',
      expectedEnvironmentPairingRevision: 1,
      timeoutMs: 15_000
    })
    await act(async () => {
      await complete(second, id)
    })
    expect(view.getAllByTestId('term_one')[0].textContent).toBe('1')
    await act(async () => {
      second.onclose?.()
      await flushCrewWork()
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(retry).toHaveBeenCalledTimes(2)
    expect(new Set(scheduler.mock.contexts).size).toBe(1)
    const held = latestCrewSocket()
    view.unmount()
    expect(held.close).toHaveBeenCalledOnce()
    await act(async () => {
      held.open()
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(retry).toHaveBeenCalledTimes(2)
    expect(ordinary).toHaveBeenCalledOnce()
  }
)

it.each([1, 10])(
  'cancels %i actual pending finite children on last release and drains late auth without reacquisition',
  async (count) => {
    const retry = vi.spyOn(api, 'subscribeCrewAttempt')
    const ordinary = vi.spyOn(api, 'subscribe')
    const scheduler = vi.spyOn(
      SharedControlReconnectScheduler.prototype,
      'scheduleWithDefaultBackoff'
    )
    const view = render(
      <>
        {Array.from({ length: count }, (_, i) => (
          <Pane key={i} party={`term_${i}`} />
        ))}
      </>
    )
    await act(async () => {
      for (let index = 0; index < count; index++) {
        const socket = CrewSocket.sockets[1 + index]
        const id = await ready(socket)
        frame(socket, id, { type: 'end' })
        await flushCrewWork()
      }
      await vi.advanceTimersByTimeAsync(250)
    })
    const held = CrewSocket.sockets.slice(1 + count)
    expect(ordinary).toHaveBeenCalledTimes(count)
    expect(retry).toHaveBeenCalledTimes(count)
    expect(held).toHaveLength(Math.min(count, 8))
    expect(new Set(scheduler.mock.contexts).size).toBe(1)
    const queueOwner: object = session.runtimeCallQueuePool
    expect('queuedCallCount' in queueOwner && queueOwner.queuedCallCount).toBe(
      Math.max(0, count - 8)
    )
    view.unmount()
    expect('queuedCallCount' in queueOwner && queueOwner.queuedCallCount).toBe(0)
    expect(held.every((socket) => socket.close.mock.calls.length === 1)).toBe(true)
    await act(async () => {
      for (const socket of held) {
        socket.open()
        socket.onerror?.()
        socket.onclose?.()
      }
      await flushCrewWork()
      await vi.advanceTimersByTimeAsync(60_000)
    })
    // The independent primary heartbeat reconnects once; no Crew child is reacquired.
    expect(CrewSocket.sockets).toHaveLength(2 + count + Math.min(count, 8))
    expect(latestCrewSocket().send).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalledTimes(count)
  }
)

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
