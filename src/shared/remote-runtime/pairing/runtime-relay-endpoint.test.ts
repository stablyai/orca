import { expect, it } from 'vitest'
import {
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../host-catalog/runtime-environments'
import { runtimeRelayEndpoint } from './runtime-relay-endpoint'

it('never shows a Relay endpoint’s invite outside the main process', () => {
  const invite = 'I'.repeat(43)
  const endpoint = runtimeRelayEndpoint({
    v: 1,
    directorUrl: 'https://relay.test',
    cellUrl: 'https://cell.test',
    assignmentEpoch: 1,
    relayHostId: 'H'.repeat(16),
    e2eeFraming: 2,
    inviteToken: invite,
    inviteExpiresAt: 4_102_444_800_000
  })
  const environment: KnownRuntimeEnvironment = {
    id: 'env-1',
    name: 'Desk',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'e1',
    endpoints: [
      {
        id: 'e1',
        kind: 'websocket',
        label: 'Relay',
        endpoint,
        deviceToken: 'device-token',
        publicKeyB64: 'key'
      }
    ]
  }
  const shown = redactRuntimeEnvironment(environment)
  expect(shown.endpoints[0].endpoint).toBe(`orca-relay:${'H'.repeat(16)}`)
  expect(JSON.stringify(shown)).not.toContain(invite)
  expect(JSON.stringify(shown)).not.toContain(
    btoa(JSON.stringify({ inviteToken: invite })).slice(0, 8)
  )
})
