import { describe, expect, it, vi } from 'vitest'
import { encrypt } from './e2ee-crypto'
import { RemoteRuntimeRequestResponseRouter } from './remote-runtime-request-response-router'

const SHARED_KEY = new Uint8Array(32).fill(7)

function createAwaitingAuthRouter() {
  const finishError = vi.fn<(error: Error) => void>()
  const router = new RemoteRuntimeRequestResponseRouter<unknown>({
    sharedKey: SHARED_KEY,
    serializedAuth: '{}',
    serializedStatusRequest: null,
    requestId: 'request-1',
    statusRequestId: null,
    send: vi.fn(),
    sendRequestedRpc: vi.fn(),
    refreshTimeout: vi.fn(),
    finishError,
    finishResponse: vi.fn()
  })
  router.state = 'awaiting_authenticated'
  return { finishError, router }
}

describe('RemoteRuntimeRequestResponseRouter authentication frames', () => {
  it('reports malformed authentication frames as invalid host identity responses', () => {
    const { finishError, router } = createAwaitingAuthRouter()

    router.handleTextFrame(encrypt('not-json', SHARED_KEY))

    expect(finishError).toHaveBeenCalledOnce()
    expect(finishError.mock.calls[0][0]).toMatchObject({
      code: 'invalid_runtime_response',
      message: 'Remote Orca runtime returned an invalid E2EE auth frame.',
      pairingStage: 'host-identity'
    })
  })

  it('reports explicit authentication rejection as a rejected pairing token', () => {
    const { finishError, router } = createAwaitingAuthRouter()
    const rejection = JSON.stringify({
      type: 'e2ee_error',
      error: { code: 'unauthorized' }
    })

    router.handleTextFrame(encrypt(rejection, SHARED_KEY))

    expect(finishError).toHaveBeenCalledOnce()
    expect(finishError.mock.calls[0][0]).toMatchObject({
      code: 'unauthorized',
      message: 'Remote Orca runtime rejected the pairing token.',
      pairingStage: 'access-grant'
    })
  })
})
