import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { encrypt, encryptBytes } from '../e2ee/node/e2ee-crypto'
import type { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { RemoteRuntimeSubscriptionFrameRouter } from './remote-runtime-subscription-frame-router'
import { createFixedKeyLegacyHandshakeForTest } from '../e2ee/paired-e2ee-fixed-key-test-fixture'

const SHARED_KEY = new Uint8Array(32).fill(7)

function handleEncryptedAuthFrame(
  router: RemoteRuntimeSubscriptionFrameRouter<unknown>,
  plaintext: string
): void {
  router.handleFrame(Buffer.from(encrypt(plaintext, SHARED_KEY)), false)
}

function createReadyRouter(callbacks: {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array) => void
}) {
  const fail = vi.fn<(error: RemoteRuntimeClientError) => void>()
  const router = new RemoteRuntimeSubscriptionFrameRouter<unknown>({
    handshake: createFixedKeyLegacyHandshakeForTest(SHARED_KEY),
    sealAuth: async () => '{}',
    isSettled: () => false,
    serializedRequest: '{}',
    requestId: 'request-1',
    send: vi.fn(),
    fail,
    onAuthenticated: vi.fn(),
    callbacks
  })
  router.state = 'ready'
  return { fail, router }
}

describe('RemoteRuntimeSubscriptionFrameRouter consumer callbacks', () => {
  it('fails the subscription instead of throwing out of the socket message handler', () => {
    const { fail, router } = createReadyRouter({
      onResponse: () => {
        throw new Error('Unknown environment: env-1')
      }
    })
    const response = JSON.stringify({
      id: 'request-1',
      ok: true,
      result: {},
      _meta: { runtimeId: 'r' }
    })

    expect(() => handleEncryptedAuthFrame(router, response)).not.toThrow()
    expect(fail).toHaveBeenCalledOnce()
    expect(fail.mock.calls[0][0]).toMatchObject({
      code: 'runtime_error',
      message: 'Unknown environment: env-1'
    })
  })

  it('fails the subscription when a binary consumer throws', () => {
    const { fail, router } = createReadyRouter({
      onResponse: vi.fn(),
      onBinary: () => {
        throw new Error('consumer exploded')
      }
    })

    expect(() =>
      router.handleFrame(Buffer.from(encryptBytes(new Uint8Array([1, 2, 3]), SHARED_KEY)), true)
    ).not.toThrow()
    expect(fail).toHaveBeenCalledOnce()
    expect(fail.mock.calls[0][0]).toMatchObject({ code: 'runtime_error' })
  })
})
