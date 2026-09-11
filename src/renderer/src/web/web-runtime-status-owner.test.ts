import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  createSharedControlTestServer,
  closeSharedControlTestServers
} from '../../../shared/remote-runtime-shared-control-test-server'
import { WebRuntimeClient } from './web-runtime-client'

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
    resultForRequest: () => ({ runtimeId, capabilities: [] })
  })
  const publish = vi.fn()
  const client = new WebRuntimeClient(server.pairing, {
    status: { environmentId: 'browser', pairingRevision: 1, publish, verified: vi.fn() }
  })
  clients.push(client)
  await expect.poll(() => client.statusOwner?.read().verification).toBe('verified')
  expect(client.statusOwner?.read().status?.runtimeId).toBe('before')
  runtimeId = 'after'
  server.closeClients()
  await expect.poll(() => client.statusOwner?.read().status?.runtimeId).toBe('after')
  expect(client.statusOwner?.read().transport).toBe('ready')
  client.close()
  expect(publish.mock.lastCall?.[0]).toMatchObject({ retired: true, verification: 'blocked' })
})
