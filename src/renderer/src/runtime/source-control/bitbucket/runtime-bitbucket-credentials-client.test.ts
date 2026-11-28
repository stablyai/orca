import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BITBUCKET_CREDENTIALS_RUNTIME_CAPABILITY } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import {
  bitbucketConnect,
  bitbucketCredentialStatus,
  bitbucketDisconnect,
  BitbucketCredentialsHostOutdatedError
} from './runtime-bitbucket-credentials-client'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), supports: vi.fn() }))
vi.mock('../../rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('../../rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports
}))

const remote = { kind: 'environment' as const, environmentId: 'wsl-host' }
const args = { authMode: 'basic' as const, email: 'dev@example.com', apiToken: 'secret' }
const localApi = { connect: vi.fn(), disconnect: vi.fn(), status: vi.fn() }

describe('Bitbucket credential routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { bitbucket: localApi } })
    mocks.supports.mockResolvedValue(true)
    mocks.rpc.mockResolvedValue({ ok: true, account: 'dev' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the credential only to the selected server', async () => {
    await expect(bitbucketConnect(remote, args)).resolves.toEqual({ ok: true, account: 'dev' })

    expect(mocks.supports).toHaveBeenCalledWith(
      'wsl-host',
      BITBUCKET_CREDENTIALS_RUNTIME_CAPABILITY
    )
    expect(mocks.rpc).toHaveBeenCalledWith(
      remote,
      'bitbucket.connect',
      args,
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(localApi.connect).not.toHaveBeenCalled()
  })

  it('reads status and disconnects on the selected server', async () => {
    await bitbucketCredentialStatus(remote)
    await bitbucketDisconnect(remote)

    expect(mocks.rpc.mock.calls.map((call) => call[1])).toEqual([
      'bitbucket.status',
      'bitbucket.disconnect'
    ])
    expect(localApi.status).not.toHaveBeenCalled()
    expect(localApi.disconnect).not.toHaveBeenCalled()
  })

  it('refuses an older server without saving the secret anywhere', async () => {
    mocks.supports.mockResolvedValue(false)

    await expect(bitbucketConnect(remote, args)).rejects.toBeInstanceOf(
      BitbucketCredentialsHostOutdatedError
    )
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(localApi.connect).not.toHaveBeenCalled()
  })

  it('reports an offline server as unreachable, not as outdated', async () => {
    const offline = new Error('Remote runtime connection closed.')
    mocks.supports.mockRejectedValue(offline)

    await expect(bitbucketConnect(remote, args)).rejects.toBe(offline)
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(localApi.connect).not.toHaveBeenCalled()
  })

  it('treats a missing method as an older server', async () => {
    mocks.rpc.mockRejectedValue(
      new RuntimeRpcCallError({
        id: '1',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' }
      })
    )

    await expect(bitbucketConnect(remote, args)).rejects.toBeInstanceOf(
      BitbucketCredentialsHostOutdatedError
    )
    expect(localApi.connect).not.toHaveBeenCalled()
  })

  it('keeps this computer on the desktop IPC', async () => {
    localApi.connect.mockResolvedValue({ ok: true, account: 'me' })

    await bitbucketConnect({ kind: 'local' }, args)
    expect(localApi.connect).toHaveBeenCalledWith(args)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
