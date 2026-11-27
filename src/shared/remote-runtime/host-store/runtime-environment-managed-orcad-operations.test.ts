import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { getOrcadSshDeployment } from '../host-catalog/runtime-environments'
import { encodePairingOffer } from '../pairing/pairing'
import { addManagedOrcadEnvironment } from './runtime-environment-managed-orcad-operations'
import { listEnvironments } from './runtime-environment-store-operations'
import { readPersistedEnvironmentStore } from './runtime-environment-store-file'
import { getEnvironmentStorePath } from './runtime-environment-store-records'
import {
  getRuntimeEnvironmentSidecarPath,
  readCurrentRuntimeEnvironmentSidecarEntry,
  writeRuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'

const directories: string[] = []
afterEach(async () => {
  await removeTempDirs(directories.splice(0))
})

function setup() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-managed-orcad-add-'))
  directories.push(userDataPath)
  let deploys = 0
  const deploy = (args: { id: string; sshTargetId: string; machine?: number; name?: string }) => {
    const localPort = 41000 + deploys++
    return addManagedOrcadEnvironment(userDataPath, {
      id: args.id,
      name: args.name ?? args.id,
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: `ws://127.0.0.1:${localPort}/runtime`,
        publicKeyB64: Buffer.alloc(32, args.machine ?? 7).toString('base64'),
        deviceToken: `token-${args.id}`,
        pairedDeviceId: 'desktop'
      }),
      orcadDeployment: {
        sshTargetId: args.sshTargetId,
        sshTargetGeneration: 1,
        localPort,
        remotePort: 6768
      },
      moveSavedServer: true
    })
  }
  const saved = () =>
    listEnvironments(userDataPath).map((entry) => [
      entry.id,
      getOrcadSshDeployment(entry)?.sshTargetId,
      getOrcadSshDeployment(entry)?.localPort,
      entry.endpoints[0]?.deviceToken
    ])
  return { userDataPath, deploy, saved }
}

function markReconciling(userDataPath: string, environmentId: string): void {
  const store = readPersistedEnvironmentStore(userDataPath)
  const persisted = store.environments.find((entry) => entry.id === environmentId)!
  const { binding: _binding, ...entry } = readCurrentRuntimeEnvironmentSidecarEntry(
    userDataPath,
    persisted
  )!
  writeRuntimeEnvironmentSidecarEntry(userDataPath, store.environments, persisted, {
    ...entry,
    reconciliation: {
      version: 1,
      stage: 'prepared',
      requestId: 'reconcile-1',
      canonicalEnvironmentId: environmentId,
      runtimeId: 'runtime-1',
      preparedAt: 1,
      registrations: [
        { environmentId, authorityDigest: 'a'.repeat(64) },
        { environmentId: 'other-registration', authorityDigest: 'b'.repeat(64) }
      ]
    }
  })
}

describe('addManagedOrcadEnvironment', () => {
  it('keeps one saved server per machine as its SSH routes change', () => {
    const { deploy, saved } = setup()
    deploy({ id: 'lan', sshTargetId: 'ssh-lan' })

    expect(deploy({ id: 'wan', sshTargetId: 'ssh-wan' }).id).toBe('lan')
    expect(saved()).toEqual([['lan', 'ssh-wan', 41000, 'token-lan']])
    expect(deploy({ id: 'back', sshTargetId: 'ssh-lan' }).id).toBe('lan')
    expect(deploy({ id: 'other', sshTargetId: 'ssh-other', machine: 9 }).id).toBe('other')
    expect(() =>
      deploy({ id: 'clash', sshTargetId: 'ssh-clash', machine: 8, name: 'lan' })
    ).toThrow(expect.objectContaining({ code: 'invalid_argument' }))
    expect(saved()).toEqual([
      ['lan', 'ssh-lan', 41000, 'token-lan'],
      ['other', 'ssh-other', 41003, 'token-other']
    ])
  })

  it('leaves a reconciling server where it is when another SSH route reaches it', () => {
    const { userDataPath, deploy } = setup()
    deploy({ id: 'lan', sshTargetId: 'ssh-lan' })
    markReconciling(userDataPath, 'lan')
    const files = () => [
      readFileSync(getEnvironmentStorePath(userDataPath), 'utf8'),
      readFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), 'utf8')
    ]
    const before = files()

    expect(() => deploy({ id: 'wan', sshTargetId: 'ssh-wan' })).toThrow(
      'Finish or cancel host reconciliation before changing this server lifecycle.'
    )
    expect(files()).toEqual(before)
  })
})
