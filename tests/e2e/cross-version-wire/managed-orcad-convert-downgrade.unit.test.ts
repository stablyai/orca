import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeSshTarget } from '../../../src/main/persistence/leasing-ssh-ptys/ssh-normalization'
import { orcadMigrationCutoverFixture } from '../../../src/main/ssh/orcad-migration-cutover-fixture'
import { writeOrcadMigrationSourceCutover } from '../../../src/main/ssh/orcad-migration-cutover-journal'
import { visibleRepos } from '../../../src/main/ssh/orcad-retained-source'
import type { Repo } from '../../../src/shared/repo-types'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

/**
 * The downgrade direction for an SSH host converted to managed orcad (#24975, #24979).
 *
 * After conversion this build fences the host in `orcadFence` and keeps its source rows retained
 * but hidden. A user who rolls back to the last release before auto-conversion must still find
 * the host and its project there and reach them over that build's relay. A fence spelled as an
 * `owner` would have hidden the host from that build, which is what this pins.
 */
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

/** What this build persists for a converted host: the relay endpoint plus its server fence. */
const persistedTarget = normalizeSshTarget({
  id: TARGET_ID,
  label: 'Converted host',
  host: 'build.example.com',
  port: 22,
  username: 'dev',
  orcadFence: { environmentId: 'env-managed' }
})
const retainedRepo: Repo = {
  id: 'repo-retained',
  path: '/home/dev/project',
  displayName: 'project',
  badgeColor: '#888888',
  addedAt: 0,
  connectionId: TARGET_ID
}

describe(`managed orcad conversion read back by ${LAST_RELAY_ONLY_REF}`, () => {
  let oldNormalize: (target: unknown) => unknown
  let OldConnectionStore: ConnectionStore
  let userDataPath: string

  beforeAll(async () => {
    // A real conversion leaves a committed cutover journal; it is what makes this build hide the rows.
    userDataPath = mkdtempSync(join(tmpdir(), 'orcad-convert-downgrade-'))
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...orcadMigrationCutoverFixture('migration-converted', TARGET_ID, {
        environmentId: 'env-managed'
      }),
      phase: 'destination-committed'
    })
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
  afterAll(() => rmSync(userDataPath, { recursive: true, force: true }))

  it('still lists the converted host with its relay endpoint', () => {
    const oldTarget = oldNormalize(persistedTarget)
    const listed = new OldConnectionStore({ getSshTargets: () => [oldTarget] }).listTargets()
    expect(listed).toEqual([
      expect.objectContaining({ id: TARGET_ID, host: 'build.example.com', port: 22 })
    ])
  })

  it('keeps the project this build retains but hides', () => {
    // That release lists every stored repo; only this build filters the retained ones out.
    const store = {
      getSshTargets: () => [persistedTarget],
      getRepos: () => [retainedRepo],
      getFolderWorkspaces: () => [],
      getProjectGroups: () => []
    }
    expect(visibleRepos(store, () => userDataPath)).toEqual([])
    expect(store.getRepos()).toEqual([expect.objectContaining({ connectionId: TARGET_ID })])
  })
})
