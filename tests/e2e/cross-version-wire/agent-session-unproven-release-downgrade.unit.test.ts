import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { resolveStructuredSessionRecovery } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-recovery-resolution'
import { AgentSessionRecordStore } from '../../../src/main/runtime/agent-session-record-store'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// The last release before recovery released an owner it could not prove gone.
const BASELINE_REF = 'v1.4.211'
const SESSION = 'session-unproven'
const NOW = 1_800_000_000_000
const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'folder' as const
}

function reserveRequest(expectedFence: number | null, spawnToken: string, operation: number) {
  return {
    sessionId: SESSION,
    location: LOCATION,
    provider: 'codex' as const,
    accountHome: { variable: 'CODEX_HOME' as const, path: '/tmp/codex' },
    // Older builds still read the owner kind from the request.
    runtimeKind: 'native' as const,
    expectedFence,
    spawnToken,
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' as const },
    operation: {
      callerKey: 'test',
      operationId: `${NOW}-${String(operation).padStart(32, '0')}`,
      fingerprint: 'create'
    },
    now: NOW
  }
}

test('an older build loads, and starts over, a lease released with no death evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-unproven-release-downgrade-'))
  try {
    // This build: an owner whose identity can never be verified is released, with no evidence.
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    const reserved = await store.reserveOwner(reserveRequest(null, 'spawn-a', 1))
    const fence = reserved.record.lease.runtimeFence
    await store.commitProcessIdentity({
      sessionId: SESSION,
      fence,
      process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken: 'spawn-a' },
      now: NOW
    })
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      lease: { ...record.lease, handoffStage: 'recovering' }
    }))
    await expect(
      resolveStructuredSessionRecovery(
        {
          store,
          probeRecord: async () => ({ outcome: 'indeterminate', reason: 'no start time' }),
          now: () => NOW
        },
        SESSION
      )
    ).resolves.toBe('resolved')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      deathEvidence: null
    })

    // The older build reads exactly what this one wrote.
    const checkout = await materializeReleaseCheckout(BASELINE_REF)
    const baseline = await importReleaseCheckoutModule(
      checkout,
      'src/main/runtime/agent-session-record-store.ts'
    )
    const OldStore = baseline.AgentSessionRecordStore as {
      open: (args: { directory: string; hostId: string }) => Promise<AgentSessionRecordStore>
    }
    const old = await OldStore.open({ directory, hostId: 'local' })
    expect(old.isSessionUnreadable(SESSION)).toBe(false)
    expect(old.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      ownerProcess: null,
      deathEvidence: null
    })
    await old.reconcileOnRestart({
      probe: async () => ({ outcome: 'indeterminate', reason: 'no owner to probe' }),
      now: NOW + 1
    })
    const released = old.getRecord(SESSION)?.lease
    expect(released).toMatchObject({ claimStatus: 'released', handoffStage: null })
    // And it can start a new owner over it.
    const restarted = await old.reserveOwner(
      reserveRequest(released?.runtimeFence ?? null, 'spawn-b', 2)
    )
    expect(restarted.record.lease).toMatchObject({ claimStatus: 'reserved' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
