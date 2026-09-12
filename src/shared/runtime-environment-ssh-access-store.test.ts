import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  markEnvironmentUsed,
  removeEnvironment,
  restoreManagedOrcadEnvironmentLink,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'
import { getPreferredPairingOffer, isManagedOrcadRuntimeEnvironment } from './runtime-environments'
import {
  linkVerifiedRuntimeEnvironmentSshAccess,
  prepareRuntimeEnvironmentSshAccessLink,
  prepareRuntimeEnvironmentSshAccessUnlink,
  completeRuntimeEnvironmentSshAccessUnlink,
  cancelRuntimeEnvironmentSshAccessLink
} from './runtime-environment-ssh-access-store'
import { z } from 'zod'

const pairing = {
  v: 2 as const,
  endpoint: 'wss://server.example/runtime',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  deviceToken: 'private-device-token',
  pairedDeviceId: 'paired-client'
}
const tunnel = { sshTargetId: 'target', sshTargetGeneration: 3, localPort: 41000, remotePort: 6768 }
const verifiedPairing = { ...pairing, endpoint: 'ws://127.0.0.1:41000/runtime' }

describe('independent paired runtime SSH access persistence', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-ssh-access-store-'))
  })
  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function seed() {
    return addEnvironmentFromPairingCode(userDataPath, {
      name: 'Independent host',
      pairingCode: encodePairingOffer(pairing),
      now: 100
    })
  }

  function prepare(expectedEnvironment = seed(), requestId = 'link-request') {
    return prepareRuntimeEnvironmentSshAccessLink(userDataPath, {
      expectedEnvironment,
      requestId,
      ...tunnel,
      targetFingerprint: 'target-fingerprint',
      now: 90
    })
  }

  function link(expectedEnvironment = seed()) {
    return linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, {
      expectedEnvironment: prepare(expectedEnvironment),
      requestId: 'link-request',
      verifiedRuntimeId: 'host-runtime',
      verifiedPairing,
      tunnel,
      now: 90
    })
  }

  function unlink(expectedEnvironment: ReturnType<typeof seed>, now?: number) {
    const prepared = prepareRuntimeEnvironmentSshAccessUnlink(userDataPath, {
      expectedEnvironment,
      requestId: 'unlink-request',
      now
    })
    return completeRuntimeEnvironmentSshAccessUnlink(userDataPath, {
      expectedEnvironment: prepared,
      requestId: 'unlink-request'
    })
  }

  it('adds access to the same host without deployment ownership and restores its original endpoint', () => {
    const original = seed()
    const linked = link(original)
    expect(listEnvironments(userDataPath)).toEqual([linked])
    expect(linked.id).toBe(original.id)
    expect(linked.name).toBe(original.name)
    expect(linked.createdAt).toBe(original.createdAt)
    expect(linked.runtimeId).toBe('host-runtime')
    expect(linked.pairingRevision).toBe(101)
    expect(linked.endpoints).toHaveLength(2)
    expect(linked.endpoints[0]).toEqual(original.endpoints[0])
    expect(getPreferredPairingOffer(linked)).toEqual(verifiedPairing)
    expect(isManagedOrcadRuntimeEnvironment(linked)).toBe(false)
    expect(linked.orcadDeployment).toBeUndefined()

    const unlinked = unlink(linked, 80)
    expect(unlinked.id).toBe(original.id)
    expect(unlinked.runtimeId).toBe('host-runtime')
    expect(unlinked.pairingRevision).toBe(102)
    expect(unlinked.endpoints).toEqual(original.endpoints)
    expect(unlinked.preferredEndpointId).toBe(original.preferredEndpointId)
    expect(unlinked.sshAccess).toBeUndefined()
    expect(unlinked.connectionDependency).toBeUndefined()
    expect(listEnvironments(userDataPath)).toEqual([unlinked])
  })

  it('refuses a link whose verification raced with re-pairing', () => {
    const original = seed()
    const replaced = updateEnvironmentFromPairingCode(userDataPath, original.id, {
      pairingCode: encodePairingOffer({ ...pairing, deviceToken: 'replacement-token' }),
      now: 100
    })
    expect(() => link(original)).toThrow('changed while SSH access')
    expect(listEnvironments(userDataPath)).toEqual([replaced])
  })

  it('permits unrelated last-used timestamp updates during verification', () => {
    const original = seed()
    markEnvironmentUsed(userDataPath, original.id, { now: 200 })
    expect(link(original).lastUsedAt).toBe(200)
  })

  it('fences legacy writers while a generic SSH link exists and restores compatibility after unlink', () => {
    const original = seed()
    const legacyEnvelope = z.object({ version: z.literal(1), environments: z.array(z.unknown()) })
    const readEnvelope = () =>
      JSON.parse(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8'))
    expect(legacyEnvelope.safeParse(readEnvelope()).success).toBe(true)
    const linked = link(original)
    expect(readEnvelope().version).toBe(2)
    expect(legacyEnvelope.safeParse(readEnvelope()).success).toBe(false)
    markEnvironmentUsed(userDataPath, linked.id, { now: 500 })
    expect(readEnvelope().version).toBe(2)
    unlink(linked)
    expect(readEnvelope().version).toBe(1)
    expect(legacyEnvelope.safeParse(readEnvelope()).success).toBe(true)
  })

  it.each([
    { ...verifiedPairing, publicKeyB64: Buffer.alloc(32, 2).toString('base64') },
    { ...verifiedPairing, deviceToken: 'another-token' },
    { ...verifiedPairing, pairedDeviceId: 'another-client' }
  ])('refuses a different authenticated host or pairing grant', (wrongPairing) => {
    const original = seed()
    const prepared = prepare(original)
    expect(() =>
      linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, {
        expectedEnvironment: prepared,
        requestId: 'link-request',
        verifiedRuntimeId: 'host-runtime',
        verifiedPairing: wrongPairing,
        tunnel
      })
    ).toThrow('did not verify')
    expect(listEnvironments(userDataPath)).toEqual([prepared])
  })

  it('refuses changing a known execution runtime identity', () => {
    const original = seed()
    markEnvironmentUsed(userDataPath, original.id, { runtimeId: 'incumbent-runtime' })
    const current = listEnvironments(userDataPath)[0]
    expect(() => link(current)).toThrow('did not verify')
    expect(listEnvironments(userDataPath)[0]).toMatchObject({
      ...current,
      updatedAt: 90,
      pendingSshAccessOperation: { operation: 'link' }
    })
  })

  it('refuses a second registration of the same execution runtime', () => {
    const original = seed()
    const duplicate = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Duplicate host',
      pairingCode: encodePairingOffer(pairing)
    })
    markEnvironmentUsed(userDataPath, duplicate.id, { runtimeId: 'host-runtime' })
    const before = listEnvironments(userDataPath)
    expect(() => link(original)).toThrow('registered more than once')
    expect(
      listEnvironments(userDataPath).find((entry) => entry.id === original.id)
        ?.pendingSshAccessOperation?.operation
    ).toBe('link')
    expect(listEnvironments(userDataPath).find((entry) => entry.id === duplicate.id)).toEqual(
      before.find((entry) => entry.id === duplicate.id)
    )
  })

  it('prevents ordinary removal, re-pairing, or promotion from orphaning SSH access', () => {
    const linked = link()
    expect(() => removeEnvironment(userDataPath, linked.id)).toThrow('Unlink')
    expect(() =>
      updateEnvironmentFromPairingCode(userDataPath, linked.id, {
        pairingCode: encodePairingOffer(pairing)
      })
    ).toThrow('Unlink')
    expect(() => restoreManagedOrcadEnvironmentLink(userDataPath, linked.id, tunnel)).toThrow(
      'Unlink'
    )
    expect(() => link(linked)).toThrow('already has SSH access')
    expect(listEnvironments(userDataPath)).toEqual([linked])
  })

  it('does not let a stale unlink remove a subsequently replaced SSH link', () => {
    const first = link()
    const unlinked = unlink(first)
    const replacement = link(unlinked)
    expect(() => unlink(first)).toThrow('changed while SSH access')
    expect(listEnvironments(userDataPath)).toEqual([replacement])
  })

  it('persists retryable link intent before target claim and fences legacy writers and pairing mutations', () => {
    const original = seed()
    const prepared = prepare(original)
    expect(prepared.endpoints).toEqual(original.endpoints)
    expect(prepared.sshAccess).toBeUndefined()
    expect(listEnvironments(userDataPath)).toEqual([prepared])
    expect(JSON.parse(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).version).toBe(2)
    expect(prepare(original)).toEqual(prepared)
    expect(prepare(prepared)).toEqual(prepared)
    expect(() => prepare(prepared, 'other-request')).toThrow('Another SSH access')
    expect(() => removeEnvironment(userDataPath, prepared.id)).toThrow('Unlink')
    expect(() =>
      updateEnvironmentFromPairingCode(userDataPath, prepared.id, {
        pairingCode: encodePairingOffer(pairing)
      })
    ).toThrow('Unlink')
    expect(() => restoreManagedOrcadEnvironmentLink(userDataPath, prepared.id, tunnel)).toThrow(
      'Unlink'
    )
    expect(() =>
      markEnvironmentUsed(userDataPath, prepared.id, { runtimeId: 'different-runtime' })
    ).toThrow('cannot change')
  })

  it('completes a matching verified link atomically and handles lost completion responses', () => {
    const prepared = prepare()
    const args = {
      expectedEnvironment: prepared,
      requestId: 'link-request',
      verifiedRuntimeId: 'host-runtime',
      verifiedPairing,
      tunnel
    }
    expect(() =>
      linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, { ...args, requestId: 'stale-request' })
    ).toThrow('pending link intent')
    expect(() =>
      linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, {
        ...args,
        tunnel: { ...tunnel, sshTargetGeneration: 4 }
      })
    ).toThrow('pending link intent')
    const linked = linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, args)
    expect(linked.pendingSshAccessOperation).toBeUndefined()
    expect(linked.sshAccess?.requestId).toBe('link-request')
    expect(linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, args)).toEqual(linked)
    expect(() =>
      linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, {
        ...args,
        verifiedRuntimeId: 'impostor'
      })
    ).toThrow('completed link')
  })

  it('keeps a durable release intent after restoring the endpoint until exact completion', () => {
    const linked = link()
    const prepared = prepareRuntimeEnvironmentSshAccessUnlink(userDataPath, {
      expectedEnvironment: linked,
      requestId: 'release-request'
    })
    expect(prepared.sshAccess).toBeUndefined()
    expect(getPreferredPairingOffer(prepared)).toEqual(pairing)
    expect(prepared.pendingSshAccessOperation).toMatchObject({
      operation: 'unlink',
      requestId: 'release-request',
      sshTargetId: tunnel.sshTargetId,
      sshTargetGeneration: tunnel.sshTargetGeneration
    })
    expect(JSON.parse(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).version).toBe(2)
    expect(
      prepareRuntimeEnvironmentSshAccessUnlink(userDataPath, {
        expectedEnvironment: prepared,
        requestId: 'release-request'
      })
    ).toEqual(prepared)
    expect(() =>
      completeRuntimeEnvironmentSshAccessUnlink(userDataPath, {
        expectedEnvironment: prepared,
        requestId: 'stale-request'
      })
    ).toThrow('pending unlink intent')
    expect(() => removeEnvironment(userDataPath, prepared.id)).toThrow('Unlink')
    const finished = completeRuntimeEnvironmentSshAccessUnlink(userDataPath, {
      expectedEnvironment: prepared,
      requestId: 'release-request'
    })
    expect(finished.pendingSshAccessOperation).toBeUndefined()
    expect(JSON.parse(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).version).toBe(1)
  })

  it('turns failed verification into durable release intent without ever publishing access', () => {
    const prepared = prepare()
    expect(() =>
      cancelRuntimeEnvironmentSshAccessLink(userDataPath, {
        expectedEnvironment: prepared,
        requestId: 'wrong'
      })
    ).toThrow('pending link intent')
    const cancelling = cancelRuntimeEnvironmentSshAccessLink(userDataPath, {
      expectedEnvironment: prepared,
      requestId: 'link-request'
    })
    expect(cancelling.endpoints).toEqual(prepared.endpoints)
    expect(cancelling.pendingSshAccessOperation?.operation).toBe('unlink')
    expect(cancelling.sshAccess).toBeUndefined()
    expect(
      cancelRuntimeEnvironmentSshAccessLink(userDataPath, {
        expectedEnvironment: cancelling,
        requestId: 'link-request'
      })
    ).toEqual(cancelling)
    const finished = completeRuntimeEnvironmentSshAccessUnlink(userDataPath, {
      expectedEnvironment: cancelling,
      requestId: 'link-request'
    })
    expect(finished.pendingSshAccessOperation).toBeUndefined()
  })
})
