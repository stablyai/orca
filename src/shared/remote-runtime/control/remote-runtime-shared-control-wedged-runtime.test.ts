// @orca-isolated-worker: mixes real socket deadlines with faked intervals, so timer state left by an
// earlier file in a shared worker can stop the probe deadline from ever firing.
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

const heartbeat = { intervalMs: 1_000, timeoutMs: 5_000 }

it('retires a ready socket whose runtime still answers pings but not requests, and reconnects (#39785)', async () => {
  // Wedged host: ws pongs keep the transport "alive" while status.get is never answered.
  const server = await createServer({ silentMethods: ['status.get'] })
  let onClosed!: (record: SharedControlSocketCloseRecord) => void
  const closed = new Promise<SharedControlSocketCloseRecord>((resolve) => {
    onClosed = resolve
  })
  let onReady = (): void => {}
  const published: RemoteRuntimeSharedConnectionDiagnostics[] = []
  const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
    appHeartbeat: { ...heartbeat, timeoutMs: 100 },
    onSocketClosed: onClosed,
    onReady: () => onReady(),
    onDiagnosticsChanged: (diagnostics) => published.push(diagnostics)
  })
  try {
    await connection.request('worktree.ps', undefined, 1000)
    const reconnected = new Promise<void>((resolve) => {
      onReady = resolve
    })
    // Await probe preparation before its real deadline; keep the clock in the same time domain.
    await vi.advanceTimersByTimeAsync(heartbeat.intervalMs)

    expect(await closed).toMatchObject({ cause: 'runtime_unresponsive', state: 'ready' })
    expect(server.requests.some((r) => r.method === 'status.get')).toBe(true)
    expect(published.some((d) => typeof d.unresponsiveSince === 'number')).toBe(true)
    // Host health keeps the mark across the reconnect until the runtime answers again.
    await reconnected
    expect(server.connectionCount()).toBeGreaterThanOrEqual(2)
    expect(connection.isReady()).toBe(true)
    expect(connection.getDiagnostics().unresponsiveSince).toEqual(expect.any(Number))
  } finally {
    connection.close()
  }
})

it('keeps a socket whose runtime answers the heartbeat', async () => {
  const server = await createServer()
  const closes: SharedControlSocketCloseRecord[] = []
  const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
    appHeartbeat: heartbeat,
    onSocketClosed: (record) => closes.push(record)
  })
  try {
    await connection.request('worktree.ps', undefined, 1000)
    for (let round = 0; round < 2; round += 1) {
      await vi.advanceTimersByTimeAsync(heartbeat.intervalMs)
      // Replies arrive in order, so the probe has been answered once this one is.
      await connection.request('worktree.ps', undefined, 1000)
    }
    const probes = server.requests.filter((r) => r.method === 'status.get')
    expect(probes.map((r) => r.params)).toEqual([{ probe: true }, { probe: true }])
    expect(closes).toEqual([])
    expect(server.connectionCount()).toBe(1)
    expect(connection.getDiagnostics().unresponsiveSince).toBeUndefined()
  } finally {
    connection.close()
  }
})

it('never probes an asleep host or a connection that did not opt in', async () => {
  const server = await createServer({ silentMethods: ['status.get'] })
  // A sleeping VM is never dialed, so the host falls asleep after its socket is up.
  let sleeping = false
  const asleep = new RemoteRuntimeSharedControlConnection(server.pairing, {
    appHeartbeat: heartbeat,
    prepareSleepCheck: () => () => sleeping
  })
  const legacy = new RemoteRuntimeSharedControlConnection(server.pairing)
  await asleep.request('worktree.ps', undefined, 1000)
  await legacy.request('worktree.ps', undefined, 1000)

  sleeping = true
  await vi.advanceTimersByTimeAsync(heartbeat.intervalMs * 5)
  sleeping = false
  // The socket delivers in order, so a probe sent while idle would reach the host before these.
  await asleep.request('worktree.ps', undefined, 1000)
  await legacy.request('worktree.ps', undefined, 1000)
  expect(server.requests.some((r) => r.method === 'status.get')).toBe(false)
  expect(asleep.isReady()).toBe(true)
  expect(legacy.isReady()).toBe(true)
  asleep.close()
  legacy.close()
})
