import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  createSharedControlTestServer,
  closeSharedControlTestServers
} from '../../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import { WebRuntimeClient } from './web-runtime-client'
import { WebRuntimeConnectionTransport } from './web-runtime-connection-transport'
import { readWebRuntimeStatus } from './web-runtime-status-request'

const clients: WebRuntimeClient[] = []
beforeEach(() => {
  vi.stubGlobal('WebSocket', WebSocket)
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
  })
})
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close())
  await closeSharedControlTestServers()
  vi.unstubAllGlobals()
})

it('primary browser status follows the authenticated socket and closing it retires the owner', async () => {
  let runtimeId = 'before'
  const server = await createSharedControlTestServer({
    resultForRequest: () => ({
      runtimeId,
      runtimeProtocolVersion: 3,
      minCompatibleRuntimeClientVersion: 2,
      rendererGraphEpoch: 0,
      graphStatus: 'unavailable',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      capabilities: []
    })
  })
  const publish = vi.fn()
  const client = new WebRuntimeClient(server.pairing, {
    status: { environmentId: 'browser', pairingRevision: 1, publish, verified: vi.fn() }
  })
  clients.push(client)
  await expect
    .poll(() => client.statusOwner?.read().verification, { timeout: 3_000 })
    .toBe('verified')
  expect(client.statusOwner?.read().status?.runtimeId).toBe('before')
  runtimeId = 'after'
  server.closeClients()
  await expect
    .poll(() => client.statusOwner?.read().status?.runtimeId, { timeout: 3_000 })
    .toBe('after')
  expect(client.statusOwner?.read().transport).toBe('ready')
  client.close()
  expect(publish.mock.lastCall?.[0]).toMatchObject({ retired: true, verification: 'blocked' })
})

it('refuses status.get that starts while the real transport reopens and accepts the next current read', async () => {
  const server = await createSharedControlTestServer({
    resultForRequest: () => ({
      runtimeId: 'current',
      runtimeProtocolVersion: 3,
      minCompatibleRuntimeClientVersion: 2,
      rendererGraphEpoch: 0,
      graphStatus: 'unavailable',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      capabilities: []
    })
  })
  const transport = new WebRuntimeConnectionTransport(server.pairing, {
    now: () => 1_000,
    isDocumentVisible: () => true
  })
  try {
    await expect.poll(() => transport.state).toBe('connected')
    const originalEpoch = transport.requestRegistry.connectionEpoch
    server.closeClients()
    await expect.poll(() => transport.state).toBe('disconnected')
    const overlapping = readWebRuntimeStatus(transport, new AbortController().signal)
    const reply = await overlapping
    expect(transport.requestRegistry.connectionEpoch).toBe(originalEpoch + 1)
    expect(server.connectionCount()).toBe(2)
    expect(reply).toMatchObject({ ok: false, error: { code: 'runtime_unavailable' } })
    expect(await readWebRuntimeStatus(transport, new AbortController().signal)).toMatchObject({
      ok: true,
      result: { runtimeId: 'current' }
    })
    expect(transport.requestRegistry.pending.size).toBe(0)
  } finally {
    transport.close()
  }
})
