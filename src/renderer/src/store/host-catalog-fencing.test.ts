import { beforeEach, describe, expect, it, vi } from 'vitest'
import { replaceRuntimeEnvironmentRevisions } from '../runtime/runtime-environment-revision'

const generations = vi.hoisted(() => ({
  connection: new Map<string, number>(),
  sshState: new Map<string, number>(),
  nestedTarget: new Map<string, number>(),
  localTarget: new Map<string, number>()
}))

vi.mock('./slices/runtime-status', () => ({
  getRuntimeEnvironmentConnectionGeneration: (id: string) => generations.connection.get(id) ?? 0
}))
vi.mock('./slices/runtime-environment-ssh', () => ({
  getEnvironmentSshStateGeneration: (id: string) => generations.sshState.get(id) ?? 0,
  getEnvironmentSshTargetConnectionGeneration: (id: string, targetId: string) =>
    generations.nestedTarget.get(`${id}/${targetId}`) ?? 0
}))
vi.mock('./slices/ssh', () => ({
  getLocalSshTargetConnectionGeneration: (targetId: string) =>
    generations.localTarget.get(targetId) ?? 0
}))

import {
  captureHostIdentityFence,
  claimHostCatalogFence,
  isHostCatalogFenceCurrent,
  isHostIdentityFenceCurrent
} from './host-catalog-fencing'

const env = { kind: 'environment', environmentId: 'env-1' } as const
const store = { removedRuntimeEnvironmentIds: new Set<string>() }
const get = (): typeof store => store

beforeEach(() => {
  for (const map of Object.values(generations)) {
    map.clear()
  }
  replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 1 }])
})

describe('host identity fence', () => {
  it('holds through catalog and SSH-state churn that the data fence rejects', () => {
    const identity = captureHostIdentityFence({ target: env, at: 'local' })
    const catalog = claimHostCatalogFence(get, 'repos', env)
    generations.sshState.set('env-1', 1)
    claimHostCatalogFence(get, 'repos', env)

    expect(isHostIdentityFenceCurrent(identity)).toBe(true)
    expect(isHostCatalogFenceCurrent(get, catalog)).toBe(false)
  })

  it('moves when the server reconnects or is re-paired to another machine', () => {
    const reconnected = captureHostIdentityFence({ target: env, at: 'local' })
    generations.connection.set('env-1', 1)
    expect(isHostIdentityFenceCurrent(reconnected)).toBe(false)

    const repaired = captureHostIdentityFence({ target: env, at: 'local' })
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 2 }], {
      retired: ['env-1'],
      sameHost: []
    })
    expect(isHostIdentityFenceCurrent(repaired)).toBe(false)
  })

  it('holds across a re-pair proven to be the same machine', () => {
    const fence = captureHostIdentityFence({ target: env, at: 'local' })
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 2 }], {
      retired: [],
      sameHost: [{ id: 'env-1', fromRevision: 1, toRevision: 2 }]
    })
    expect(isHostIdentityFenceCurrent(fence)).toBe(true)
  })

  it('moves when the server is removed', () => {
    const fence = captureHostIdentityFence({ target: env, at: 'local' })
    replaceRuntimeEnvironmentRevisions([])
    expect(isHostIdentityFenceCurrent(fence)).toBe(false)
  })

  it('tracks only the nested SSH target the route names', () => {
    const fence = captureHostIdentityFence({ target: env, at: 'ssh:box' })
    generations.nestedTarget.set('env-1/other', 3)
    expect(isHostIdentityFenceCurrent(fence)).toBe(true)
    generations.nestedTarget.set('env-1/box', 1)
    expect(isHostIdentityFenceCurrent(fence)).toBe(false)
  })

  it('tracks a directly dialed SSH target by its local connection generation', () => {
    const fence = captureHostIdentityFence({ target: { kind: 'local' }, at: 'ssh:box' })
    generations.nestedTarget.set('env-1/box', 1)
    expect(isHostIdentityFenceCurrent(fence)).toBe(true)
    generations.localTarget.set('box', 1)
    expect(isHostIdentityFenceCurrent(fence)).toBe(false)
  })
})
