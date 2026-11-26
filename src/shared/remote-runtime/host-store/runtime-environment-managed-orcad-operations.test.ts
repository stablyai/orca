import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { getOrcadSshDeployment } from '../host-catalog/runtime-environments'
import { encodePairingOffer } from '../pairing/pairing'
import { addManagedOrcadEnvironment } from './runtime-environment-managed-orcad-operations'
import { listEnvironments } from './runtime-environment-store-operations'

const hostKey = Buffer.alloc(32, 7).toString('base64')

function deploy(
  userDataPath: string,
  args: {
    id: string
    name: string
    sshTargetId: string
    sshTargetGeneration: number
    localPort: number
    publicKeyB64?: string
  }
) {
  return addManagedOrcadEnvironment(userDataPath, {
    id: args.id,
    name: args.name,
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: `ws://127.0.0.1:${args.localPort}/runtime`,
      publicKeyB64: args.publicKeyB64 ?? hostKey,
      deviceToken: `token-${args.id}`,
      pairedDeviceId: `device-${args.id}`
    }),
    orcadDeployment: {
      sshTargetId: args.sshTargetId,
      sshTargetGeneration: args.sshTargetGeneration,
      localPort: args.localPort,
      remotePort: 6768
    },
    moveSavedServer: true,
    now: 100
  })
}

const lan = { id: 'lan', name: 'dell', sshTargetId: 'ssh-lan', sshTargetGeneration: 1 }

describe('addManagedOrcadEnvironment', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-managed-orcad-add-'))
  })
  afterEach(async () => {
    await removeTempDirs([userDataPath])
  })

  it('moves the saved server to a second SSH route to the same machine', () => {
    deploy(userDataPath, { ...lan, localPort: 41000 })

    const moved = deploy(userDataPath, {
      id: 'wan',
      name: 'dell-remote',
      sshTargetId: 'ssh-wan',
      sshTargetGeneration: 2,
      localPort: 41001
    })

    expect(listEnvironments(userDataPath)).toEqual([moved])
    expect(moved).toMatchObject({
      id: 'lan',
      name: 'dell',
      orcadDeployment: {
        sshTargetId: 'ssh-wan',
        sshTargetGeneration: 2,
        localPort: 41000,
        remotePort: 6768
      },
      endpoints: [{ endpoint: 'ws://127.0.0.1:41000/runtime', deviceToken: 'token-lan' }]
    })
  })

  it('saves a different machine as its own server', () => {
    deploy(userDataPath, { ...lan, localPort: 41000 })
    deploy(userDataPath, {
      id: 'other',
      name: 'other',
      sshTargetId: 'ssh-other',
      sshTargetGeneration: 2,
      localPort: 41001,
      publicKeyB64: Buffer.alloc(32, 9).toString('base64')
    })

    expect(
      listEnvironments(userDataPath)
        .map((entry) => [entry.id, getOrcadSshDeployment(entry)?.sshTargetId])
        .sort()
    ).toEqual([
      ['lan', 'ssh-lan'],
      ['other', 'ssh-other']
    ])
  })

  it('still refuses a different machine under a saved id or name', () => {
    deploy(userDataPath, { ...lan, localPort: 41000 })
    const otherMachine = {
      sshTargetId: 'ssh-other',
      sshTargetGeneration: 2,
      localPort: 41001,
      publicKeyB64: Buffer.alloc(32, 9).toString('base64')
    }

    expect(() => deploy(userDataPath, { ...otherMachine, id: 'lan', name: 'other' })).toThrow(
      expect.objectContaining({ code: 'invalid_argument' })
    )
    expect(() => deploy(userDataPath, { ...otherMachine, id: 'other', name: 'dell' })).toThrow(
      expect.objectContaining({ code: 'invalid_argument' })
    )
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual(['lan'])
  })
})
