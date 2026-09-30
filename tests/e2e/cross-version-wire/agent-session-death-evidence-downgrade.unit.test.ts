import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../src/shared/agent-session-record.test-fixture'
import { AgentSessionRecordStore } from '../../../src/main/runtime/agent-session-record-store'
import { agentSessionStorePath } from '../../../src/main/runtime/agent-session-record-store-file'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// The last release before a proof of death named its owner and its last proof of life.
const BASELINE_REF = 'v1.4.211'
const SESSION = 'session-alpha-1'

// Why the explicit budget: a cold run may extract the pinned release inside this test.
test('an older build loads a proof of death that names its owner and its last proof of life', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-death-evidence-downgrade-'))
  try {
    // A live owner at fence 7, last renewed at 30000, found gone when this build relaunches.
    writeFileSync(
      agentSessionStorePath(directory),
      JSON.stringify({
        schemaVersion: 2,
        hostId: 'local',
        records: { [SESSION]: agentSessionRecordFixture(agentSessionLeaseFixture()) },
        operations: {},
        retiredClaimKeys: [],
        unusableRecords: {}
      })
    )
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    await store.reconcileOnRestart({ probe: async () => ({ outcome: 'pid-absent' }), now: 90_000 })
    const evidence = store.getRecord(SESSION)?.lease.deathEvidence
    expect(evidence).toEqual({
      kind: 'pid-absent',
      detail: 'recorded pid absent on host',
      observedAt: 90_000,
      ownerFence: 7,
      lastProvenAliveAt: 30_000
    })

    const checkout = await materializeReleaseCheckout(BASELINE_REF)
    const baseline = await importReleaseCheckoutModule(
      checkout,
      'src/main/runtime/agent-session-record-store.ts'
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release exports this class with the open/read members called below; a missing one fails the test.
    const OldStore = baseline.AgentSessionRecordStore as {
      open: (args: { directory: string; hostId: string }) => Promise<AgentSessionRecordStore>
    }
    const old = await OldStore.open({ directory, hostId: 'local' })
    expect(old.isSessionUnreadable(SESSION)).toBe(false)
    expect(old.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: evidence
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 180_000)
