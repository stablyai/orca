import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import type {
  RemoteRuntimeSharedConnectionDiagnostics,
  SharedControlSocketCloseRecord
} from './remote-runtime-shared-control-types'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer as createServer
} from './remote-runtime-shared-control-test-server'

// Fake only the heartbeat's interval and clock; socket I/O and request deadlines stay real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
})
afterEach(async () => {
  vi.useRealTimers()
  await closeSharedControlTestServers()
})

const heartbeat = { intervalMs: 1_000, timeoutMs: 60 }

it('retires a ready socket whose runtime still answers pings but not requests, and reconnects (#39785)', async () => {
  // Wedged host: ws pongs keep the transport "alive" while status.get is never answered.
  const server = await createServer({ silentMethods: ['status.get'] })
  const closes: SharedControlSocketCloseRecord[] = []
  const published: RemoteRuntimeSharedConnectionDiagnostics[] = []
  const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
    appHeartbeat: heartbeat,
    onSocketClosed: (record) => closes.push(record),
    onDiagnosticsChanged: (diagnostics) => published.push(diagnostics)
  })
  await connection.request('worktree.ps', undefined, 1000)

  await vi.waitFor(() => expect(server.connectionCount()).toBeGreaterThanOrEqual(2), {
    timeout: 3000
  })
  expect(closes[0]).toMatchObject({
    cause: 'runtime_unresponsive',
    state: 'ready'
  })
  expect(server.requests.some((r) => r.method === 'status.get')).toBe(true)
  expect(published.some((d) => typeof d.unresponsiveSince === 'number')).toBe(true)
  // Host health keeps the mark across the reconnect until the runtime answers again.
  await vi.waitFor(() => expect(connection.isReady()).toBe(true))
  expect(connection.getDiagnostics().unresponsiveSince).toEqual(expect.any(Number))
  connection.close()
})

it('keeps a socket whose runtime answers the heartbeat', async () => {
  const server = await createServer()
  const closes: SharedControlSocketCloseRecord[] = []
  const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
    appHeartbeat: heartbeat,
    onSocketClosed: (record) => closes.push(record)
  })
  await connection.request('worktree.ps', undefined, 1000)

  await vi.waitFor(
    () =>
      expect(server.requests.filter((r) => r.method === 'status.get').length).toBeGreaterThan(1),
    { timeout: 3000 }
  )
  expect(server.requests.find((r) => r.method === 'status.get')?.params).toEqual({ probe: true })
  expect(closes).toEqual([])
  expect(server.connectionCount()).toBe(1)
  expect(connection.getDiagnostics().unresponsiveSince).toBeUndefined()
  connection.close()
})

it('never probes an asleep host or a connection that did not opt in', async () => {
  const server = await createServer({ silentMethods: ['status.get'] })
  const asleep = new RemoteRuntimeSharedControlConnection(server.pairing, {
    appHeartbeat: heartbeat,
    isAsleep: () => true
  })
  const legacy = new RemoteRuntimeSharedControlConnection(server.pairing)
  await asleep.request('worktree.ps', undefined, 1000)
  await legacy.request('worktree.ps', undefined, 1000)

  vi.advanceTimersByTime(heartbeat.intervalMs * 5)
  // The socket delivers in order, so a probe sent while idle would reach the host before these.
  await asleep.request('worktree.ps', undefined, 1000)
  await legacy.request('worktree.ps', undefined, 1000)
  expect(server.requests.some((r) => r.method === 'status.get')).toBe(false)
  expect(asleep.isReady()).toBe(true)
  expect(legacy.isReady()).toBe(true)
  asleep.close()
  legacy.close()
})
