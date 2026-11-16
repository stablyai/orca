import { afterEach, expect, it, vi } from 'vitest'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import type { SharedControlSocketCloseRecord } from './remote-runtime-shared-control-types'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer as createServer
} from './remote-runtime-shared-control-test-server'

afterEach(closeSharedControlTestServers)

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

it('retires a socket that opens but never becomes ready and reconnects with backoff', async () => {
  const server = await createServer({ suppressReadyFrameCount: 1 })
  const closes: SharedControlSocketCloseRecord[] = []
  const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
    readyDeadlineMs: 100,
    onSocketClosed: (record) => closes.push(record)
  })

  await expect(connection.request('worktree.ps', undefined, 2000)).rejects.toThrow(
    'did not finish connecting'
  )
  expect(closes).toMatchObject([{ cause: 'ready_timeout', state: 'awaiting_ready' }])
  await vi.waitFor(() => expect(connection.isReady()).toBe(true))
  expect(server.connectionCount()).toBe(2)
  connection.close()
})
