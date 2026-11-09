import { beforeAll, describe, expect, it } from 'vitest'
import { normalizeSshTarget } from '../../../src/main/persistence/leasing-ssh-ptys/ssh-normalization'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// Pin pre-conversion readers: orcadFence must retain relay access and project rows on rollback; owner would hide them (#24975, #24979).
const LAST_RELAY_ONLY_REF = 'v1.4.218'
const SUITE_TIMEOUT_MS = 180_000
const TARGET_ID = 'ssh-converted'

type ConnectionStore = new (store: { getSshTargets: () => unknown[] }) => {
  listTargets: () => { id: string; host: string; port: number }[]
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}

function isConstructor(value: unknown): value is ConnectionStore {
  return typeof value === 'function'
}

const persistedTarget = normalizeSshTarget({
  id: TARGET_ID,
  label: 'Converted host',
  host: 'build.example.com',
  port: 22,
  username: 'dev',
  orcadFence: { environmentId: 'env-managed' }
})

describe(`managed orcad conversion read back by ${LAST_RELAY_ONLY_REF}`, () => {
  let oldNormalize: (target: unknown) => unknown
  let OldConnectionStore: ConnectionStore

  beforeAll(async () => {
    const checkout = await materializeReleaseCheckout(LAST_RELAY_ONLY_REF)
    const normalization = await importReleaseCheckoutModule(
      checkout,
      'src/main/persistence/leasing-ssh-ptys/ssh-normalization.ts'
    )
    const connections = await importReleaseCheckoutModule(
      checkout,
      'src/main/ssh/ssh-connection-store.ts'
    )
    if (
      !isFunction(normalization.normalizeSshTarget) ||
      !isConstructor(connections.SshConnectionStore)
    ) {
      throw new Error(`${LAST_RELAY_ONLY_REF} no longer exports the SSH target readers this pins`)
    }
    const normalize = normalization.normalizeSshTarget
    oldNormalize = (target) => normalize(target)
    OldConnectionStore = connections.SshConnectionStore
  }, SUITE_TIMEOUT_MS)

  it('still lists the converted host with its relay endpoint', () => {
    const oldTarget = oldNormalize(persistedTarget)
    const listed = new OldConnectionStore({ getSshTargets: () => [oldTarget] }).listTargets()
    expect(listed).toEqual([
      expect.objectContaining({ id: TARGET_ID, host: 'build.example.com', port: 22 })
    ])
  })
})
