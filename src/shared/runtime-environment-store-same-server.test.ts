import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  addOrUpdateEnvironmentFromPairingCode,
  listEnvironments,
  resolveEnvironmentPairingOffer
} from './runtime-environment-store'
import { addManagedOrcadEnvironment } from './runtime-environment-managed-orcad-store'

const serverKey = Buffer.alloc(32, 7).toString('base64')

function pairingCode(endpoint: string, deviceToken = 'first-token', publicKeyB64 = serverKey) {
  return encodePairingOffer({ v: 2, endpoint, deviceToken, publicKeyB64 })
}

describe('pairing a server that is already saved', () => {
  let userDataPath: string
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  beforeEach(() => {
    // Why: this suite tests store contents, while secure-file tests cover Windows ACLs.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-same-server-'))
  })
  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('refreshes the saved entry instead of saving the server twice under a new name', () => {
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio',
      pairingCode: pairingCode('ws://192.0.2.10:6768'),
      now: 100
    })

    const outcome = addOrUpdateEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio over relay',
      pairingCode: pairingCode('wss://relay.example/runtime', 'second-token'),
      runtimeId: 'runtime-after-restart',
      now: 200
    })

    expect(outcome.updatedExisting).toBe(true)
    expect(outcome.environment).toMatchObject({
      id: first.id,
      name: 'Studio',
      createdAt: 100,
      updatedAt: 200,
      runtimeId: 'runtime-after-restart'
    })
    expect(outcome.environment.pairingRevision).toBeGreaterThan(first.pairingRevision ?? 0)
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual([first.id])
    expect(resolveEnvironmentPairingOffer(userDataPath, first.id)).toMatchObject({
      endpoint: 'wss://relay.example/runtime',
      deviceToken: 'second-token'
    })
  })

  it('refuses a second entry for the same server where it cannot switch connections over', () => {
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio',
      pairingCode: pairingCode('ws://192.0.2.10:6768')
    })
    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'Studio again',
        pairingCode: pairingCode('ws://192.0.2.10:6768', 'second-token')
      })
    ).toThrow(
      'This server is already paired as "Studio". To update its connection, add it again under Settings > Remote Orca Servers.'
    )
    expect(listEnvironments(userDataPath)).toEqual([first])
  })

  it("refreshes the saved server when the code is entered under the server's own name", () => {
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio',
      pairingCode: pairingCode('ws://192.0.2.10:6768')
    })
    const outcome = addOrUpdateEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio',
      pairingCode: pairingCode('ws://192.0.2.10:6768', 'second-token')
    })
    expect(outcome).toMatchObject({ updatedExisting: true, environment: { id: first.id } })
  })

  it('matches the same key spelled unpadded or URL-safe', () => {
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio',
      pairingCode: pairingCode('ws://192.0.2.10:6768')
    })
    const urlSafeUnpadded = Buffer.alloc(32, 0xfb).toString('base64url')
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'Wide',
      pairingCode: pairingCode(
        'ws://192.0.2.12:6768',
        'token',
        Buffer.alloc(32, 0xfb).toString('base64')
      )
    })
    for (const spelling of [serverKey.replace(/=+$/, ''), urlSafeUnpadded]) {
      const target = spelling === urlSafeUnpadded ? 'Wide' : 'Studio'
      expect(
        addOrUpdateEnvironmentFromPairingCode(userDataPath, {
          name: `${target} again`,
          pairingCode: pairingCode('ws://192.0.2.20:6768', 'other-token', spelling)
        })
      ).toMatchObject({ updatedExisting: true, environment: { name: target } })
    }
    // The saved spelling stays, so the host-key fingerprint the renderer compares is unchanged.
    expect(resolveEnvironmentPairingOffer(userDataPath, first.id)).toMatchObject({
      publicKeyB64: serverKey,
      deviceToken: 'other-token'
    })
    expect(resolveEnvironmentPairingOffer(userDataPath, 'Wide').publicKeyB64).toBe(
      Buffer.alloc(32, 0xfb).toString('base64')
    )
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toContain(first.id)
    expect(listEnvironments(userDataPath)).toHaveLength(2)
  })

  it('still saves a different server as its own entry', () => {
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio',
      pairingCode: pairingCode('ws://192.0.2.10:6768')
    })
    const outcome = addOrUpdateEnvironmentFromPairingCode(userDataPath, {
      name: 'Laptop',
      pairingCode: pairingCode(
        'ws://192.0.2.11:6768',
        'token',
        Buffer.alloc(32, 8).toString('base64')
      )
    })
    expect(outcome.updatedExisting).toBe(false)
    expect(listEnvironments(userDataPath).map((entry) => entry.name)).toEqual(['Laptop', 'Studio'])
  })

  it('takes the tunnel dependency from the new pairing, not the replaced one', () => {
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio',
      pairingCode: pairingCode('ws://127.0.0.1:41000/runtime'),
      connectionDependency: 'ssh-tunnel'
    })
    expect(first.connectionDependency).toBe('ssh-tunnel')

    const outcome = addOrUpdateEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio on LAN',
      pairingCode: pairingCode('ws://192.0.2.10:6768')
    })
    expect(outcome.environment.connectionDependency).toBeUndefined()
  })

  it('refuses, naming the saved entry, when Orca manages that server over SSH', () => {
    const managed = addManagedOrcadEnvironment(userDataPath, {
      id: 'managed',
      name: 'Managed box',
      pairingCode: pairingCode('ws://127.0.0.1:41000/runtime'),
      orcadDeployment: {
        sshTargetId: 'target',
        sshTargetGeneration: 1,
        localPort: 41000,
        remotePort: 6768
      },
      now: 100
    })

    expect(() =>
      addOrUpdateEnvironmentFromPairingCode(userDataPath, {
        name: 'Managed box by hand',
        pairingCode: pairingCode('ws://192.0.2.10:6768', 'second-token')
      })
    ).toThrow('This server is already paired as "Managed box".')
    expect(listEnvironments(userDataPath)).toEqual([managed])
  })

  it('refuses to fold a cloud workspace server into a saved entry', () => {
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Studio',
      pairingCode: pairingCode('ws://192.0.2.10:6768')
    })
    expect(() =>
      addOrUpdateEnvironmentFromPairingCode(userDataPath, {
        name: 'VM',
        pairingCode: pairingCode('ws://192.0.2.20:6768', 'vm-token'),
        source: 'ephemeral-vm'
      })
    ).toThrow('This server is already paired as "Studio".')
    expect(listEnvironments(userDataPath)).toEqual([first])
  })
})
