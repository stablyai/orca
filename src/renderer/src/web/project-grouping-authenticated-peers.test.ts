import '../../../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createStore,
  closeTestStores,
  readDataFile,
  testState
} from '../../../main/persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../../../main/runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../../../main/runtime/runtime-rpc'
import { DeviceRegistry } from '../../../main/runtime/device-registry'
import {
  MobileSocketWiring,
  type MobileSocketTransport
} from '../../../main/runtime/rpc/mobile-socket-wiring'
import { CLIENT_UI_METHODS } from '../../../main/runtime/rpc/methods/client-ui'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from '../../../main/runtime/rpc/methods/runtime-client-capabilities'
import { generateKeyPair, deriveSharedKey, encrypt } from '../../../shared/e2ee-crypto'
import { WEB_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/web-runtime-client-capabilities'
import { mobileRuntimeClientCapabilityUpdateParams } from '../../../../mobile/src/transport/mobile-runtime-client-capabilities'
import WebSocket, { WebSocketServer } from 'ws'
import { STATUS_METHODS } from '../../../main/runtime/rpc/methods/status'
import { installBrowserGlobals } from './web-preload-api-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../../main/telemetry/client', () => ({ track: vi.fn() }))

it.each(['web', 'mobile', 'old'] as const)(
  'carries the %s capability producer through a real mobile authenticated socket into persisted filter edits',
  async (origin) => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-exact-peers-'))
    const store = createStore()
    const runtime = new OrcaRuntimeService(store)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: testState.dir,
      methods: [...CLIENT_UI_METHODS, ...RUNTIME_CLIENT_CAPABILITY_METHODS],
      enableWebSocket: false
    })
    const registry = new DeviceRegistry(testState.dir)
    server['deviceRegistry'] = registry
    const device = registry.addDevice('Fixture phone', 'mobile')
    const desktop = generateKeyPair()
    const pending: Promise<void>[] = []
    const wiring = new MobileSocketWiring({
      deviceRegistry: registry,
      e2eeKeypair: { ...desktop, publicKeyB64: Buffer.from(desktop.publicKey).toString('base64') },
      onText: (socket, message, reply) => {
        pending.push(
          server['handleWebSocketMessage'](
            message,
            reply,
            () => {},
            undefined,
            socket.ws,
            socket.device.deviceToken,
            socket
          )
        )
      },
      onBinary: () => {},
      onClose: () => {}
    })
    let receive: Parameters<MobileSocketTransport['onMessage']>[0] = () => {}
    const transport: MobileSocketTransport = {
      onMessage: (callback) => {
        receive = callback
      },
      onConnectionClose: () => {},
      setClientId: () => {},
      terminateClientConnections: () => 0
    }
    wiring.attachTransport(transport)
    class Socket extends EventEmitter {
      readonly OPEN = 1
      readyState = 1
      bufferedAmount = 0
      send = vi.fn()
      close = vi.fn()
    }
    const Q = 'runtime:server\0same'
    try {
      const socket = new Socket()
      // SAFETY: the production wiring needs WebSocket's EventEmitter/send/close surface only.
      const ws = socket as unknown as WebSocket
      const phone = generateKeyPair()
      receive(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: Buffer.from(phone.publicKey).toString('base64')
        }),
        () => {},
        ws
      )
      const key = deriveSharedKey(phone.secretKey, desktop.publicKey)
      receive(
        encrypt(
          JSON.stringify({
            type: 'e2ee_auth',
            deviceToken: device.token,
            clientCapabilities: origin === 'web' ? [...WEB_RUNTIME_CLIENT_CAPABILITIES] : []
          }),
          key
        ),
        () => {},
        ws
      )
      const send = async (id: string, method: string, params: unknown) => {
        receive(encrypt(JSON.stringify({ id, method, params }), key), () => {}, ws)
        await Promise.all(pending.splice(0))
      }
      if (origin === 'mobile') {
        await send(
          'install',
          'runtime.clientCapabilities.update',
          mobileRuntimeClientCapabilityUpdateParams()
        )
      }
      for (const initial of [
        ['same', Q],
        ['same', 'local\0same', Q]
      ]) {
        store.updateUI({ filterRepoIds: initial, agentsFilterRepoIds: [Q] })
        await send('edit', 'ui.set', {
          filterRepoIds: [Q, 'offline'],
          ...(origin !== 'old' ? { filterRepoIdsMode: 'exact' } : {}),
          agentsFilterRepoIds: []
        })
        expect(store.getUI().filterRepoIds).toEqual(origin === 'old' ? ['offline'] : [Q, 'offline'])
        expect(store.getUI().agentsFilterRepoIds).toEqual([Q])
        store.flush()
        expect(readDataFile()).toHaveProperty(
          'ui.filterRepoIds',
          origin === 'old' ? ['offline'] : [Q, 'offline']
        )
      }
      await send('clear', 'ui.set', { filterRepoIds: [] })
      expect(store.getUI().filterRepoIds).toEqual([])
      store.flush()
      await closeTestStores()
      expect(createStore().getUI()).toMatchObject({ filterRepoIds: [], agentsFilterRepoIds: [Q] })
    } finally {
      wiring.dispose()
      await closeTestStores()
      rmSync(testState.dir, { recursive: true, force: true })
    }
  }
)

it.each([100, 1000])(
  'recovers undecodable owner status and %i superseding browser writes on an installed foreground wake through settlement and disk',
  async (count) => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-browser-filter-owner-'))
    const store = createStore()
    const runtime = new OrcaRuntimeService(store)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: testState.dir,
      methods: [...CLIENT_UI_METHODS, ...STATUS_METHODS],
      enableWebSocket: false
    })
    const registry = new DeviceRegistry(testState.dir)
    server['deviceRegistry'] = registry
    const device = registry.addDevice('Fixture browser', 'runtime')
    const desktop = generateKeyPair()
    let malformed = true
    const requests: { method: string; params?: unknown }[] = []
    const authLists: string[][] = []
    const wiring = new MobileSocketWiring({
      deviceRegistry: registry,
      e2eeKeypair: { ...desktop, publicKeyB64: Buffer.from(desktop.publicKey).toString('base64') },
      onReady: (socket) => {
        authLists.push([...socket.clientCapabilities])
      },
      onText: (socket, message, reply) => {
        const request = JSON.parse(message)
        requests.push(request)
        void server['handleWebSocketMessage'](
          message,
          (response) => {
            const parsed = JSON.parse(response)
            reply(
              request.method === 'status.get' && malformed && parsed.ok
                ? JSON.stringify({ ...parsed, result: null })
                : response
            )
          },
          () => {},
          undefined,
          socket.ws,
          socket.device.deviceToken,
          socket
        )
      },
      onBinary: () => {},
      onClose: () => {}
    })
    let receive: Parameters<MobileSocketTransport['onMessage']>[0] = () => {}
    let closed: Parameters<MobileSocketTransport['onConnectionClose']>[0] = () => {}
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => wss.once('listening', resolve))
    const transport: MobileSocketTransport = {
      onMessage: (callback) => {
        receive = callback
      },
      onConnectionClose: (callback) => {
        closed = callback
      },
      setClientId: () => {},
      terminateClientConnections: () => 0
    }
    wiring.attachTransport(transport)
    wss.on('connection', (ws) => {
      ws.on('message', (bytes) => receive(bytes.toString(), (response) => ws.send(response), ws))
      ws.on('close', () => closed(null, ws, false))
    })
    const globals = installBrowserGlobals('Linux')
    Object.assign(globals.window, { setTimeout, clearTimeout, setInterval, clearInterval })
    const visibility = new EventTarget()
    Object.assign(visibility, { visibilityState: 'visible' })
    vi.stubGlobal('document', visibility)
    vi.stubGlobal('WebSocket', WebSocket)
    const installedWakes = vi.spyOn(visibility, 'addEventListener')
    const releasedWakes = vi.spyOn(visibility, 'removeEventListener')
    const address = wss.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected listening fixture socket')
    }
    globals.storage.setItem(
      'orca.web.runtimeEnvironment.v1',
      JSON.stringify({
        id: 'owner',
        name: 'Desktop',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        preferredEndpointId: 'ws-owner',
        endpoints: [
          {
            id: 'ws-owner',
            kind: 'websocket',
            label: 'WebSocket',
            endpoint: `ws://127.0.0.1:${address.port}`,
            deviceToken: device.token,
            publicKeyB64: Buffer.from(desktop.publicKey).toString('base64')
          }
        ]
      })
    )
    vi.resetModules()
    const session = await import('./preload-api/web-runtime-session')
    const { createWebUiApi } = await import('./preload-api/web-ui-api')
    const Q = 'runtime:server\0same'
    try {
      store.updateUI({ filterRepoIds: ['same', Q], agentsFilterRepoIds: [Q] })
      const mutations = vi.spyOn(store, 'updateUI')
      const ui = createWebUiApi()
      const superseded: Promise<unknown>[] = [
        ui.setWithAck!({ filterRepoIds: [Q], sortBy: 'name', agentsFilterRepoIds: [] }).catch(
          (error) => error
        )
      ]
      await vi.waitFor(() =>
        expect(session.webRuntimeState.activeClient?.statusOwner?.read().verification).toBe(
          'blocked'
        )
      )
      expect(requests.filter((request) => request.method === 'ui.set')).toEqual([])
      for (let index = 0; index < count - 1; index++) {
        superseded.push(
          ui.setWithAck!({ filterRepoIds: [Q, `offline-${index}`] }).catch((error) => error)
        )
      }
      const selected = [Q, `offline-${count - 1}`]
      const writing = ui.setWithAck!({ filterRepoIds: selected })
      await vi.waitFor(() =>
        expect(requests.filter((request) => request.method === 'ui.set')).toEqual([
          expect.objectContaining({ params: { sortBy: 'name' } })
        ])
      )
      malformed = false
      visibility.dispatchEvent(new Event('visibilitychange'))
      await writing
      expect(requests.filter((request) => request.method === 'ui.set')).toEqual([
        expect.objectContaining({ params: { sortBy: 'name' } }),
        expect.objectContaining({ params: { filterRepoIds: selected, filterRepoIdsMode: 'exact' } })
      ])
      expect(await Promise.all(superseded)).toEqual(
        Array.from({ length: count }, () => expect.any(Error))
      )
      expect(store.getUI()).toMatchObject({
        filterRepoIds: selected,
        sortBy: 'name',
        agentsFilterRepoIds: [Q]
      })
      expect(JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}')).not.toHaveProperty(
        'filterRepoIdsMode'
      )
      await ui.set({ filterRepoIds: [] })
      expect(store.getUI().filterRepoIds).toEqual([])
      expect(
        requests.filter((request) => request.method === 'status.get').length
      ).toBeLessThanOrEqual(5)
      expect(requests.filter((request) => request.method === 'ui.set')).toHaveLength(3)
      expect(mutations).toHaveBeenCalledTimes(3)
      expect(
        requests.filter((request) => request.method === 'runtime.clientCapabilities.update')
      ).toHaveLength(0)
      expect(authLists).toHaveLength(1)
      expect(authLists[0]).not.toContain('ui.project-repo-filter-exact.v1')
      store.flush()
      expect(readDataFile()).toHaveProperty('ui.filterRepoIds', [])
      expect(readDataFile()).not.toHaveProperty('ui.filterRepoIdsMode')
      await closeTestStores()
      expect(createStore().getUI()).toMatchObject({ filterRepoIds: [], agentsFilterRepoIds: [Q] })
    } finally {
      session.closeActiveRuntimeClients()
      const installed = installedWakes.mock.calls
        .filter(([event]) => event === 'visibilitychange')
        .map(([, listener]) => listener)
      const released = releasedWakes.mock.calls
        .filter(([event]) => event === 'visibilitychange')
        .map(([, listener]) => listener)
      // Transport liveness and status revalidation own distinct foreground interests.
      expect(installed).toHaveLength(2)
      expect(new Set(released)).toEqual(new Set(installed))
      const retiredRequests = requests.length
      visibility.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
      expect(requests).toHaveLength(retiredRequests)
      for (const socket of wss.clients) {
        socket.close()
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      wiring.dispose()
      vi.unstubAllGlobals()
      await closeTestStores()
      rmSync(testState.dir, { recursive: true, force: true })
    }
  }
)
