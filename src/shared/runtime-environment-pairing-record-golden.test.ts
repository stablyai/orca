import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as StoreFile from './runtime-environment-store-file'
import type * as Sidecar from './runtime-environment-sidecar'
import type * as WslDeploymentStore from './wsl-host-deployment-store'

// Golden bytes and write order for both pairing-record stores: older desktops read these files.
const writes = vi.hoisted(() => {
  const log: string[] = []
  return { log }
})

vi.mock('./runtime-environment-store-file', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreFile>()
  return {
    ...actual,
    writeEnvironmentStore: (...args: Parameters<typeof actual.writeEnvironmentStore>) => {
      writes.log.push(`store[${args[1].environments.map((entry) => entry.id).join(',')}]`)
      return actual.writeEnvironmentStore(...args)
    }
  }
})
vi.mock('./runtime-environment-sidecar', async (importOriginal) => {
  const actual = await importOriginal<typeof Sidecar>()
  return {
    ...actual,
    writeRuntimeEnvironmentSidecarEntry: (
      ...args: Parameters<typeof actual.writeRuntimeEnvironmentSidecarEntry>
    ) => {
      writes.log.push(`sidecar[${args[2].id}:${args[3] ? 'set' : 'clear'}]`)
      return actual.writeRuntimeEnvironmentSidecarEntry(...args)
    }
  }
})
vi.mock('./wsl-host-deployment-store', async (importOriginal) => {
  const actual = await importOriginal<typeof WslDeploymentStore>()
  return {
    ...actual,
    writeWslHostDeployment: (...args: Parameters<typeof actual.writeWslHostDeployment>) => {
      writes.log.push(`wsl[${args[1]}:${args[2] ? 'set' : 'clear'}]`)
      return actual.writeWslHostDeployment(...args)
    }
  }
})

import { encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  markEnvironmentUsed
} from './runtime-environment-store'
import {
  addManagedOrcadEnvironment,
  refreshManagedOrcadPairing,
  removeManagedOrcadEnvironment
} from './runtime-environment-managed-orcad-store'
import {
  addWslHostEnvironment,
  refreshWslHostPairing,
  removeWslHostEnvironment
} from './runtime-environment-wsl-host-store'

const FILES = [
  'orca-environments.json',
  'orca-environment-sidecar.json',
  'orca-wsl-host-deployments.json'
]

function code(port: number, deviceToken = 'token-1', pairedDeviceId?: string): string {
  return encodePairingOffer({
    v: 2,
    endpoint: `ws://127.0.0.1:${port}`,
    deviceToken,
    publicKeyB64: Buffer.alloc(32, 7).toString('base64'),
    ...(pairedDeviceId ? { pairedDeviceId } : {})
  })
}

const sshDeployment = {
  sshTargetId: 'ssh-1',
  sshTargetGeneration: 4,
  localPort: 46_768,
  remotePort: 6_768
}
const wslRecord = {
  kind: 'wsl' as const,
  distro: 'Ubuntu',
  distroId: '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f',
  localPort: 42_000,
  remotePort: 6_768
}

describe('pairing record golden files', () => {
  let userDataPath: string
  const steps: { step: string; writes: string[]; files: Record<string, string | null> }[] = []

  function capture(step: string, run: () => unknown): void {
    writes.log.length = 0
    let outcome: string
    try {
      const result = run()
      outcome = result === undefined ? 'ok' : `ok ${JSON.stringify(result)}`
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      const errorCode = 'code' in failure ? String(failure.code) : 'none'
      outcome = `threw ${failure.constructor.name}(${errorCode}): ${failure.message}`
    }
    const files: Record<string, string | null> = {}
    for (const name of FILES) {
      const path = join(userDataPath, name)
      files[name] = existsSync(path) ? readFileSync(path, 'utf8') : null
    }
    steps.push({ step: `${step} -> ${outcome}`, writes: [...writes.log], files })
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-pairing-golden-'))
    steps.length = 0
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('keeps the SSH-managed store byte-identical across add, refresh and remove', () => {
    const add = (overrides: Partial<Parameters<typeof addManagedOrcadEnvironment>[1]>) =>
      addManagedOrcadEnvironment(userDataPath, {
        id: 'managed-1',
        name: 'Managed',
        pairingCode: code(46_768),
        orcadDeployment: sshDeployment,
        now: 100,
        ...overrides
      })
    capture('add paired neighbour', () =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'Zeta',
        pairingCode: encodePairingOffer({
          v: 2,
          endpoint: 'ws://203.0.113.5:7000',
          deviceToken: 'zeta-token',
          publicKeyB64: Buffer.alloc(32, 9).toString('base64')
        }),
        now: 10
      })
    )
    capture('add invalid code', () => add({ pairingCode: 'not-a-code' }))
    capture('add wrong port', () => add({ pairingCode: code(1234) }))
    capture('add', () => add({}))
    capture('add duplicate id', () => add({ name: 'Other' }))
    capture('add duplicate name', () => add({ id: 'managed-2' }))
    capture('add bad code with a taken id', () => add({ pairingCode: 'nope' }))
    capture('add taken id and name with the wrong port', () => add({ pairingCode: code(1234) }))
    capture('add taken name with the wrong port', () =>
      add({ id: 'managed-2', pairingCode: code(1234) })
    )
    capture('add second sorts first', () =>
      add({ id: 'managed-0', name: 'Alpha', pairingCode: code(46_768, 'alpha') })
    )
    capture('mark used with a runtime', () =>
      markEnvironmentUsed(userDataPath, 'managed-1', { runtimeId: 'runtime-a', now: 150 })
    )
    capture('refresh invalid code', () =>
      refreshManagedOrcadPairing(userDataPath, 'managed-1', 'nope', 200)
    )
    capture('refresh unchanged', () =>
      refreshManagedOrcadPairing(userDataPath, 'managed-1', code(46_768), 200)
    )
    capture('refresh rotated token', () =>
      refreshManagedOrcadPairing(
        userDataPath,
        'managed-1',
        code(46_768, 'token-2', 'device-9'),
        300
      )
    )
    capture('refresh revision bump below previous', () =>
      refreshManagedOrcadPairing(userDataPath, 'managed-1', code(46_768, 'token-3'), 50)
    )
    capture('refresh wrong port', () =>
      refreshManagedOrcadPairing(userDataPath, 'managed-1', code(1234, 'token-4'), 400)
    )
    capture('refresh unmanaged', () =>
      refreshManagedOrcadPairing(
        userDataPath,
        listEnvironments(userDataPath).find((entry) => entry.name === 'Zeta')?.id ?? 'missing',
        code(1),
        400
      )
    )
    capture('remove', () => removeManagedOrcadEnvironment(userDataPath, 'managed-1'))
    expect(steps.map((step) => normalizeUuids(step.step))).toMatchSnapshot('outcomes')
    expect(
      steps.map(({ step, writes: order, files }) => ({
        step: step.split(' -> ')[0],
        order: order.map(normalizeUuids),
        files: normalizeGeneratedFields(files)
      }))
    ).toMatchSnapshot('files')
  })

  it('keeps the WSL host store byte-identical across add, refresh and remove', () => {
    const add = (overrides: Partial<Parameters<typeof addWslHostEnvironment>[1]>) =>
      addWslHostEnvironment(userDataPath, {
        id: 'wsl:ubuntu',
        name: 'Ubuntu (WSL)',
        pairingCode: code(42_000),
        record: wslRecord,
        now: 100,
        ...overrides
      })
    const refresh = (
      pairingCode: string,
      ports: { localPort: number; remotePort: number },
      now: number
    ) => refreshWslHostPairing(userDataPath, 'wsl:ubuntu', { pairingCode, ...ports }, now)
    capture('add SSH-managed neighbour', () =>
      addManagedOrcadEnvironment(userDataPath, {
        id: 'managed-1',
        name: 'Managed',
        pairingCode: code(46_768),
        orcadDeployment: sshDeployment,
        now: 90
      })
    )
    capture('add invalid code', () => add({ pairingCode: 'not-a-code' }))
    capture('add wrong port', () => add({ pairingCode: code(1234) }))
    capture('add', () => add({}))
    capture('add duplicate id', () => add({ name: 'Other' }))
    capture('add duplicate name', () => add({ id: 'wsl:debian' }))
    capture('refresh invalid code', () =>
      refresh('nope', { localPort: 42_000, remotePort: 6_768 }, 200)
    )
    capture('mark used with a runtime', () =>
      markEnvironmentUsed(userDataPath, 'wsl:ubuntu', { runtimeId: 'runtime-w', now: 150 })
    )
    capture('refresh unchanged', () =>
      refresh(code(42_000), { localPort: 42_000, remotePort: 6_768 }, 200)
    )
    capture('refresh moved remote port only', () =>
      refresh(code(42_000), { localPort: 42_000, remotePort: 6_769 }, 250)
    )
    capture('refresh rotated token', () =>
      refresh(code(42_000, 'token-2', 'device-9'), { localPort: 42_000, remotePort: 6_769 }, 300)
    )
    capture('refresh moved bridge', () =>
      refresh(code(42_001, 'token-2', 'device-9'), { localPort: 42_001, remotePort: 6_769 }, 50)
    )
    capture('managed refresh of a WSL host', () =>
      refreshManagedOrcadPairing(userDataPath, 'wsl:ubuntu', code(42_002, 'token-6'), 600)
    )
    capture('refresh wrong port', () =>
      refresh(code(1234, 'token-5'), { localPort: 42_002, remotePort: 6_769 }, 500)
    )
    capture('refresh not a WSL host', () =>
      refreshWslHostPairing(
        userDataPath,
        'managed-1',
        { pairingCode: code(1), localPort: 1, remotePort: 2 },
        500
      )
    )
    capture('remove', () => removeWslHostEnvironment(userDataPath, 'wsl:ubuntu'))
    capture('remove again', () => removeWslHostEnvironment(userDataPath, 'wsl:ubuntu'))
    expect(steps.map((step) => step.step)).toMatchSnapshot('outcomes')
    expect(
      steps.map(({ step, writes: order, files }) => ({
        step: step.split(' -> ')[0],
        order: order.map(normalizeUuids),
        files: normalizeGeneratedFields(files)
      }))
    ).toMatchSnapshot('files')
  })
})

/** The generic store mints a random id; everything else is pinned verbatim. */
function normalizeUuids(text: string): string {
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (uuid) =>
    uuid === wslRecord.distroId ? uuid : '<uuid>'
  )
}

function normalizeGeneratedFields(
  files: Record<string, string | null>
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, text === null ? null : normalizeUuids(text)])
  )
}
