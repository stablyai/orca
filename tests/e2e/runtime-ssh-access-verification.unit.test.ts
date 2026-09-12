import { afterEach, describe, expect, it } from 'vitest'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../../src/shared/remote-runtime-shared-control-test-server'
import { createEnvironmentFromPairingOffer } from '../../src/shared/runtime-environments'
import { RUNTIME_PROTOCOL_VERSION } from '../../src/shared/protocol-version'
import { verifyRuntimeEnvironmentSshTunnel } from '../../src/main/ssh/runtime-ssh-access-verification'

afterEach(closeSharedControlTestServers)

describe('SSH access verification through the real encrypted runtime client', () => {
  it('authenticates the saved grant and reads status from the bound endpoint', async () => {
    const server = await createSharedControlTestServer({
      responseResult: () => ({
        runtimeId: 'runtime-test',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: null,
        liveTabCount: 0,
        liveLeafCount: 0,
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        deviceScope: 'runtime'
      })
    })
    const environment = createEnvironmentFromPairingOffer({
      id: 'independent-host',
      name: 'Independent host',
      now: 1,
      runtimeId: 'runtime-test',
      offer: { ...server.pairing, endpoint: 'wss://unreachable.example/proxy/runtime' }
    })

    const result = await verifyRuntimeEnvironmentSshTunnel(
      environment,
      Number(new URL(server.pairing.endpoint).port)
    )

    expect(result.verifiedRuntimeId).toBe('runtime-test')
    expect(result.verifiedPairing.publicKeyB64).toBe(server.pairing.publicKeyB64)
    expect(server.auths).toHaveLength(1)
    expect(server.auths[0]).toMatchObject({ deviceToken: server.pairing.deviceToken })
    expect(server.requests.map((request) => request.method)).toEqual(['status.get'])
  })

  it('never authenticates or sends runtime requests when the listener has another encryption key', async () => {
    const server = await createSharedControlTestServer()
    const environment = createEnvironmentFromPairingOffer({
      id: 'independent-host',
      name: 'Independent host',
      now: 1,
      runtimeId: 'runtime-test',
      offer: { ...server.pairing, publicKeyB64: Buffer.alloc(32, 3).toString('base64') }
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300)
    try {
      await expect(
        verifyRuntimeEnvironmentSshTunnel(
          environment,
          Number(new URL(server.pairing.endpoint).port),
          controller.signal
        )
      ).rejects.toThrow()
      expect(server.auths).toEqual([])
      expect(server.requests).toEqual([])
    } finally {
      clearTimeout(timer)
    }
  })
})
