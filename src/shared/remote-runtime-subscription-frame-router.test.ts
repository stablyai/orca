import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { encrypt } from './e2ee-crypto'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { RemoteRuntimeSubscriptionFrameRouter } from './remote-runtime-subscription-frame-router'

const SHARED_KEY = new Uint8Array(32).fill(7)

function createAwaitingAuthRouter() {
  const fail = vi.fn<(error: RemoteRuntimeClientError) => void>()
  const router = new RemoteRuntimeSubscriptionFrameRouter<unknown>({
    sharedKey: SHARED_KEY,
    serializedAuth: '{}',
    serializedRequest: '{}',
    requestId: 'request-1',
    send: vi.fn(),
    fail,
    onAuthenticated: vi.fn(),
    callbacks: { onResponse: vi.fn() }
  })
  router.state = 'awaiting_authenticated'
  return { fail, router }
}

function handleEncryptedAuthFrame(
  router: RemoteRuntimeSubscriptionFrameRouter<unknown>,
  plaintext: string
): void {
  router.handleFrame(Buffer.from(encrypt(plaintext, SHARED_KEY)), false)
}

describe('RemoteRuntimeSubscriptionFrameRouter authentication frames', () => {
  it('reports malformed authentication frames as invalid responses', () => {
    const { fail, router } = createAwaitingAuthRouter()

    handleEncryptedAuthFrame(router, 'not-json')

    expect(fail).toHaveBeenCalledOnce()
    expect(fail.mock.calls[0][0]).toMatchObject({
      code: 'invalid_runtime_response',
      message: 'Remote Orca runtime returned an invalid E2EE auth frame.'
    })
  })

  it('reports explicit authentication rejection as a rejected pairing token', () => {
    const { fail, router } = createAwaitingAuthRouter()
    const rejection = JSON.stringify({
      type: 'e2ee_error',
      error: { code: 'unauthorized' }
    })

    handleEncryptedAuthFrame(router, rejection)

    expect(fail).toHaveBeenCalledOnce()
    expect(fail.mock.calls[0][0]).toMatchObject({
      code: 'unauthorized',
      message: 'Remote Orca runtime rejected the pairing token.'
    })
  })
})
