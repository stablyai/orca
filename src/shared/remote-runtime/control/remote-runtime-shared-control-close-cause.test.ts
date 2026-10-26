import { afterEach, expect, it, vi } from 'vitest'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import type { SharedControlSocketCloseRecord } from './remote-runtime-shared-control-types'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer as createServer
} from './remote-runtime-shared-control-test-server'

afterEach(closeSharedControlTestServers)

it('reports a silent socket as a keepalive timeout, with its uptime', async () => {
  const server = await createServer({ disableAutoPong: true })
  const closes: SharedControlSocketCloseRecord[] = []
  const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
    liveness: { pingIntervalMs: 50, livenessTimeoutMs: 200 },
    onSocketClosed: (record) => closes.push(record)
  })

  await connection.request('worktree.ps', undefined, 1000)
  await vi.waitFor(() => expect(closes.length).toBeGreaterThan(0), { timeout: 5000 })

  expect(closes[0]).toMatchObject({
    cause: 'keepalive_timeout',
    closeCode: null,
    state: 'ready',
    lastRttMs: null
  })
  expect(closes[0]?.socketUptimeMs).toBeGreaterThanOrEqual(200)
  expect(closes[0]?.readyUptimeMs).toBeGreaterThanOrEqual(0)
  connection.close()
})

it('measures keepalive round trips and reports a server close with its code', async () => {
  const server = await createServer()
  const closes: SharedControlSocketCloseRecord[] = []
  const publishedCauses: unknown[] = []
  const connection: RemoteRuntimeSharedControlConnection = new RemoteRuntimeSharedControlConnection(
    server.pairing,
    {
      liveness: { pingIntervalMs: 50, livenessTimeoutMs: 1000 },
      onSocketClosed: (record) => closes.push(record),
      onDiagnosticsChanged: (diagnostics) => publishedCauses.push(diagnostics.lastCloseCause)
    }
  )

  await connection.request('worktree.ps', undefined, 1000)
  await vi.waitFor(() => expect(connection.getDiagnostics().lastRttMs).toBeGreaterThanOrEqual(0))
  server.closeClients()
  await vi.waitFor(() => expect(closes.length).toBeGreaterThan(0))

  expect(closes[0]).toMatchObject({ cause: 'socket_close', closeCode: 4001 })
  expect(closes[0]?.lastRttMs).toBeGreaterThanOrEqual(0)
  expect(publishedCauses).toContain('socket_close')
  connection.close()
})

it('reports an unexpected binary frame as a protocol error, not a transport failure', async () => {
  const server = await createServer({ sendBinaryAfterAuth: true })
  const closes: SharedControlSocketCloseRecord[] = []
  const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
    onSocketClosed: (record) => closes.push(record)
  })

  await connection.request('worktree.ps', undefined, 1000).catch(() => undefined)
  await vi.waitFor(() => expect(closes.length).toBeGreaterThan(0))

  expect(closes[0]).toMatchObject({
    cause: 'protocol_error',
    errorCode: 'invalid_runtime_response'
  })
  connection.close()
})
