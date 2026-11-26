import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { encodePairingOffer } from '../pairing/pairing'
import { addManagedOrcadEnvironment } from './runtime-environment-managed-orcad-operations'
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

function deploy(
  userDataPath: string,
  args: { id: string; sshTargetId: string; localPort: number }
) {
  return addManagedOrcadEnvironment(userDataPath, {
    id: args.id,
    name: args.id,
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: `ws://127.0.0.1:${args.localPort}/runtime`,
      publicKeyB64: Buffer.alloc(32, 7).toString('base64'),
      deviceToken: `token-${args.id}`,
      pairedDeviceId: 'desktop'
    }),
    orcadDeployment: {
      sshTargetId: args.sshTargetId,
      sshTargetGeneration: 1,
      localPort: args.localPort,
      remotePort: 6768
    },
    moveSavedServer: true
  })
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
  it('leaves a reconciling server where it is when another SSH route reaches it', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-managed-orcad-add-'))
    directories.push(userDataPath)
    deploy(userDataPath, { id: 'lan', sshTargetId: 'ssh-lan', localPort: 41000 })
    markReconciling(userDataPath, 'lan')
    const read = () => [
      readFileSync(getEnvironmentStorePath(userDataPath), 'utf8'),
      readFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), 'utf8')
    ]
    const before = read()

    expect(() =>
      deploy(userDataPath, { id: 'wan', sshTargetId: 'ssh-wan', localPort: 41001 })
    ).toThrow('Finish or cancel host reconciliation before changing this server lifecycle.')
    expect(read()).toEqual(before)
  })
})
