import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodePairingCode,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

const ENVIRONMENT_KEY = 'orca.web.runtimeEnvironment.v1'
const INSTALL_A = '11111111-1111-4111-8111-111111111111'
const INSTALL_B = '22222222-2222-4222-8222-222222222222'

function readStored(storage: Storage): Record<string, unknown> {
  const stored: unknown = JSON.parse(storage.getItem(ENVIRONMENT_KEY) ?? '{}')
  return typeof stored === 'object' && stored !== null
    ? Object.fromEntries(Object.entries(stored))
    : {}
}

async function installWithStoredServer(
  pin?: Record<string, unknown>
): Promise<ReturnType<typeof installBrowserGlobals>> {
  const globals = installBrowserGlobals('Linux')
  writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
  if (pin) {
    globals.storage.setItem(
      ENVIRONMENT_KEY,
      JSON.stringify({ ...readStored(globals.storage), hostDescriptor: pin })
    )
  }
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  return globals
}

describe('web re-pairing the same server', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the execution-host id and refreshes the credentials (#11574)', async () => {
    const globals = await installWithStoredServer()

    const paired = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server A again',
      pairingCode: encodePairingCode({
        publicKeyB64: 'public-key',
        deviceToken: 'fresh-token',
        hostDescriptor: { installationId: INSTALL_A }
      })
    })

    expect(paired.environment).toMatchObject({ id: 'web-server-a', createdAt: 1 })
    expect(paired.environment.pairingRevision).toBeGreaterThan(1)
    expect(paired.environment).not.toHaveProperty('hostDescriptor')
    expect(readStored(globals.storage)).toMatchObject({
      id: 'web-server-a',
      hostDescriptor: { installationId: INSTALL_A },
      endpoints: [{ id: 'ws-web-server-a', deviceToken: 'fresh-token' }]
    })
    expect(readStored(globals.storage)).not.toHaveProperty('compatibleEnvironmentIds')
  })

  it('mints a new id for a same-key server whose pinned installation changed', async () => {
    const globals = await installWithStoredServer({ installationId: INSTALL_A })

    const paired = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Clone',
      pairingCode: encodePairingCode({
        publicKeyB64: 'public-key',
        hostDescriptor: { installationId: INSTALL_B }
      })
    })

    expect(paired.environment.id).not.toBe('web-server-a')
    expect(readStored(globals.storage)).toMatchObject({
      hostDescriptor: { installationId: INSTALL_B }
    })
  })

  it('keeps the old pin when a downgraded server sends no descriptor', async () => {
    const globals = await installWithStoredServer({ installationId: INSTALL_A })

    const paired = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server A',
      pairingCode: encodePairingCode({ publicKeyB64: 'public-key' })
    })

    expect(paired.environment.id).toBe('web-server-a')
    expect(readStored(globals.storage)).toMatchObject({
      hostDescriptor: { installationId: INSTALL_A }
    })
  })

  it('drops a malformed pinned descriptor instead of trusting it', async () => {
    const globals = await installWithStoredServer({ installationId: 'not-a-uuid' })

    const paired = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server A',
      pairingCode: encodePairingCode({
        publicKeyB64: 'public-key',
        hostDescriptor: { installationId: INSTALL_B }
      })
    })

    expect(paired.environment.id).toBe('web-server-a')
    expect(readStored(globals.storage)).toMatchObject({
      hostDescriptor: { installationId: INSTALL_B }
    })
  })
})
