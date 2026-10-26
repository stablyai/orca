import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime-client-error'
import { isWebHostUnreachableAtStartup } from './startup-web-host-unreachable'

vi.mock('sonner', () => ({ toast: vi.fn() }))

function stubWindow(webClient: boolean, snapshots: unknown[]): void {
  vi.stubGlobal('window', {
    __ORCA_WEB_CLIENT__: webClient,
    api: { runtimeEnvironments: { getStatusSnapshots: vi.fn(async () => snapshots) } }
  })
}

// Pins which boot failures read as "host unreachable" (round-2 S5), so a dropped code is deliberate.
describe('isWebHostUnreachableAtStartup', () => {
  beforeEach(() => {
    stubWindow(true, [])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    'remote_runtime_unavailable',
    'remote_runtime_busy',
    'runtime_rpc_queue_overloaded',
    'runtime_timeout',
    'runtime_unavailable',
    'reconnecting',
    'timeout'
  ])('treats %s as unreachable while the transport is down', async (code) => {
    await expect(
      isWebHostUnreachableAtStartup(new RemoteRuntimeClientError(code, 'failed'))
    ).resolves.toBe(true)
  })

  it.each([
    'Timed out while connecting to the remote Orca runtime.',
    'Remote Orca runtime connection interrupted.',
    'Could not connect to the remote Orca runtime.'
  ])('treats the code-less message "%s" as unreachable', async (message) => {
    await expect(isWebHostUnreachableAtStartup(new Error(message))).resolves.toBe(true)
  })

  it.each(['runtime_manually_disconnected', 'invalid_runtime_response', 'unauthorized'])(
    'treats %s as a hydration fault',
    async (code) => {
      await expect(
        isWebHostUnreachableAtStartup(new RemoteRuntimeClientError(code, 'failed'))
      ).resolves.toBe(false)
    }
  )

  it('treats a connection failure on a ready transport as a hydration fault', async () => {
    stubWindow(true, [{ transport: 'ready', retired: false }])
    await expect(
      isWebHostUnreachableAtStartup(new RemoteRuntimeClientError('runtime_timeout', 'failed'))
    ).resolves.toBe(false)
  })

  it('is never true outside the web client', async () => {
    stubWindow(false, [])
    await expect(
      isWebHostUnreachableAtStartup(new RemoteRuntimeClientError('runtime_timeout', 'failed'))
    ).resolves.toBe(false)
  })
})
