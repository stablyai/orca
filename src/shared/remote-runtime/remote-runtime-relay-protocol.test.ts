import { describe, expect, it, vi } from 'vitest'
import { pairedRuntimeConnectionFromOffer } from '../paired-runtime-connection'
import { openAfterRemoteRuntimeRelayResolution } from './remote-runtime-relay-protocol'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'

describe('runtime connection opening', () => {
  it.each([false, true])('reports opening exceptions through failed (Relay: %s)', async (relay) => {
    const connection = pairedRuntimeConnectionFromOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'device-token',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    })
    if (relay) {
      connection.relayConnection = {
        v: 1,
        directorUrl: 'https://relay.example.com',
        cellUrl: 'https://cell.example.com',
        assignmentEpoch: 1,
        relayHostId: 'AbCdEf0123_-xyZ9',
        e2eeFraming: 2,
        credential: 'I'.repeat(43),
        credentialKind: 'invite'
      }
    }
    const error = new RemoteRuntimeClientError('unauthorized', 'Access rejected while opening')
    const failed = vi.fn()
    openAfterRemoteRuntimeRelayResolution(
      connection,
      () => {
        throw error
      },
      failed
    )
    await Promise.resolve()
    expect(failed).toHaveBeenCalledExactlyOnceWith(error)
  })
})
