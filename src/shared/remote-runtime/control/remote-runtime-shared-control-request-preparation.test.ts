import { afterEach, expect, it } from 'vitest'
import { federationRelayPrefix } from '../../../main/runtime/orchestration/federation-relay-prefix'
import { REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES } from '../remote-runtime-memory-limits'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer as createServer
} from './remote-runtime-shared-control-test-server'

afterEach(closeSharedControlTestServers)

it('sends only the relay prefix that fits the host request bound over shared control', async () => {
  const server = await createServer()
  const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
  const items = Array.from({ length: 100 }, (_, i) => ({
    dispatch_id: 'dispatch_remote',
    direction: 'to_worker' as const,
    sequence: i + 1,
    message_id: `m${i}`,
    kind: 'control_message',
    payload: JSON.stringify({ body: 'x'.repeat(12 * 1024) })
  }))
  let selectedThrough = 0

  const response = await connection.request(
    'orchestration.federationImport',
    { dispatchId: 'dispatch_remote', items },
    5000,
    { orchestrationRequestId: 'relay_import_dispatch_remote_100' },
    undefined,
    {
      prepareRequest: federationRelayPrefix('dispatch_remote', items, (last) => {
        selectedThrough = last
      })
    }
  )

  expect(response.ok).toBe(true)
  expect(selectedThrough).toBeGreaterThan(0)
  expect(selectedThrough).toBeLessThan(items.length)
  expect(server.requests).toHaveLength(1)
  expect(server.requests[0]).toMatchObject({
    params: { dispatchId: 'dispatch_remote', items: items.slice(0, selectedThrough) },
    orchestrationRequestId: `relay_import_dispatch_remote_${selectedThrough}`
  })
  expect(Buffer.byteLength(JSON.stringify(server.requests[0]))).toBeLessThanOrEqual(
    REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES
  )
  connection.close()
})
