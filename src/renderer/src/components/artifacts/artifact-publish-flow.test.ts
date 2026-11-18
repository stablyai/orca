import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ orcaProfileAuthStatus: { state: 'connected' } })
  }
}))

import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { publishArtifactFromSurface } from './artifact-publish-flow'

const request = {
  sourceKey: '/repo/report.html',
  content: '<h1>Hi</h1>',
  contentType: 'text/html' as const,
  fileName: 'report.html'
}

function rpcFailure(code: string, message: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'request-1',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'runtime-1' }
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('publishArtifactFromSurface', () => {
  it('keeps internal error text out of the toast for other failures', async () => {
    mocks.call.mockRejectedValue(rpcFailure('runtime_error', 'orca_cloud_request_failed_500'))

    await publishArtifactFromSurface(async () => request)

    expect(mocks.toastError).toHaveBeenCalledWith('Could not share artifact', undefined)
  })
})
