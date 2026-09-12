import { beforeEach, expect, it, vi } from 'vitest'
import type { SshConnection } from '../../../src/main/ssh/ssh-connection'
import { execCommand } from '../../../src/main/ssh/ssh-relay-deploy-helpers'
import {
  encodePairingOffer,
  decodePairingOffer,
  PAIRING_OFFER_VERSION
} from '../../../src/shared/pairing'
import { createLiveCatalogSshDestination } from './orcad-live-catalog-ssh-destination'
import { sendRemoteRuntimeRequest } from '../../../src/shared/remote-runtime-client'

vi.mock('../../../src/main/ssh/ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))
vi.mock('../../../src/shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: vi.fn() }))
beforeEach(() => vi.resetAllMocks())
const create = () =>
  createLiveCatalogSshDestination({
    connection: {} as SshConnection,
    directory: '/tmp/fixture/destination',
    artifactDirectory: '/tmp/fixture/artifact',
    remotePort: 6768,
    localPort: 45678
  })
const readiness = JSON.stringify({
  type: 'orca_server_ready',
  runtimeId: 'runtime-fixture',
  pairing: {
    available: true,
    url: encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://127.0.0.1:6768/runtime',
      deviceToken: 'fixture-token',
      publicKeyB64: 'fixture-key',
      pairedDeviceId: 'fixture-device'
    })
  }
})

it('uses Bun, isolated profile, exact test flags, and rewrites the endpoint through SSH', async () => {
  vi.mocked(execCommand).mockResolvedValueOnce('321').mockResolvedValueOnce(readiness)
  const destination = create()
  const serving = await destination.start()
  expect(decodePairingOffer(serving.pairing.url).endpoint).toBe('ws://127.0.0.1:45678/runtime')
  const script = vi.mocked(execCommand).mock.calls[0][1]
  expect(script).toContain("'/tmp/fixture/artifact/bun-runtime'")
  expect(script).toContain('ORCA_BACKGROUND_LAUNCH=1 ORCA_TEST_MOCK_KEYCHAIN=1')
  expect(script).toContain('ORCA_ENABLE_PTY_OWNERSHIP_TRANSFER_MUTATION=1')
  expect(script).toContain("HOME='/tmp/fixture/destination/home'")
  await expect(destination.start()).rejects.toThrow('already_running')
})

it.each(['SIGTERM', 'SIGKILL'] as const)(
  'signals only the validated owned PID using %s',
  async (signal) => {
    vi.mocked(execCommand)
      .mockResolvedValueOnce('321')
      .mockResolvedValueOnce(readiness)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('Z')
    const destination = create()
    await destination.start()
    await destination.stop(signal)
    const command = vi.mocked(execCommand).mock.calls[2][1]
    expect(command).toContain("grep -Fx -- '/tmp/fixture/artifact/orcad.js'")
    expect(command).toContain(`kill -${signal.slice(3)} 321`)
    await destination.stop()
    expect(execCommand).toHaveBeenCalledTimes(4)
  }
)

it('does not use an invalid PID in a later stop command', async () => {
  vi.mocked(execCommand).mockResolvedValueOnce('321; unsafe')
  const destination = create()
  await expect(destination.start()).rejects.toThrow('pid_invalid')
  await destination.stop()
  expect(execCommand).toHaveBeenCalledTimes(1)
})

it('preserves an unverifiable stop failure instead of claiming the process exited', async () => {
  vi.mocked(execCommand)
    .mockResolvedValueOnce('321')
    .mockResolvedValueOnce(readiness)
    .mockRejectedValueOnce(new Error('SSH disconnected'))
  const destination = create()
  await destination.start()
  await expect(destination.stop()).rejects.toThrow('SSH disconnected')
  await expect(destination.start()).rejects.toThrow('already_running')
})

it('rebinds the same runtime credentials to a fresh SSH transport without relaunching', async () => {
  vi.mocked(execCommand).mockResolvedValueOnce('321').mockResolvedValueOnce(readiness)
  vi.mocked(sendRemoteRuntimeRequest).mockResolvedValue({
    id: 'request-fixture',
    ok: true,
    result: {},
    _meta: { runtimeId: 'runtime-fixture' }
  })
  const destination = create()
  const serving = await destination.start()
  const nextConnection = {} as SshConnection
  destination.rebindTransport(nextConnection, 56789)
  await destination.rpc('terminal.list', {})
  expect(sendRemoteRuntimeRequest).toHaveBeenCalledOnce()
  expect(vi.mocked(sendRemoteRuntimeRequest).mock.calls[0][0]).toEqual({
    ...decodePairingOffer(serving.pairing.url),
    endpoint: 'ws://127.0.0.1:56789/runtime'
  })
  expect(execCommand).toHaveBeenCalledTimes(2)
  vi.mocked(execCommand).mockResolvedValueOnce('').mockResolvedValueOnce('Z')
  await destination.stop('SIGKILL')
  expect(vi.mocked(execCommand).mock.calls[2][0]).toBe(nextConnection)
})

it('refuses a transport rebind before destination readiness', () => {
  expect(() => create().rebindTransport({} as SshConnection, 56789)).toThrow('not_started')
  expect(execCommand).not.toHaveBeenCalled()
})
