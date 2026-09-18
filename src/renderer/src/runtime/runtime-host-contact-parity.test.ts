import { describe, expect, it } from 'vitest'
import {
  isRuntimeHostContactRevoked,
  type RuntimeHostStatusSnapshot
} from '../../../shared/runtime-host-status'
import {
  isRuntimeHostContactRevokedVerdict,
  lastRuntimeHostAnswer,
  liveRuntimeHostStatus,
  runtimeHostContactFromSnapshot
} from '../../../shared/runtime-host-contact'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  runtimeHostConnectionState,
  runtimeHostConnectionStateForEntry,
  type RuntimeHostConnectionState
} from './runtime-host-connection-state'

// This file exists to prove the contact introduced here changes nothing. It carries a frozen copy
// of the derivation as it stood before, and asserts the shipping one agrees with it on every
// combination of the inputs it reads. A behaviour change would have to survive the whole
// cross-product to go unnoticed, which is a much harder thing to do by accident than to argue.

type Entry = {
  status: RuntimeStatus | null
  remoteControl?: RuntimeStatus['remoteControl'] | null
  snapshot?: RuntimeHostStatusSnapshot
}

/** The derivation exactly as it read before `RuntimeHostContact` existed. Do not refactor. */
function legacyRuntimeHostConnectionStateForEntry(
  entry: Entry | null | undefined
): RuntimeHostConnectionState {
  const snapshot = entry?.snapshot
  if (snapshot) {
    if (snapshot.retired || snapshot.verification === 'blocked') {
      return 'disconnected'
    }
    if (snapshot.transport === 'disconnected') {
      return 'reconnecting'
    }
    if (snapshot.verification === 'checking' && !entry?.status) {
      return 'checking'
    }
    if (snapshot.transport === 'ready' && snapshot.verification !== 'verified') {
      return 'runtime-unavailable'
    }
  }
  return runtimeHostConnectionState({
    hasStatusEntry: Boolean(entry),
    status: entry?.status ?? null,
    ...(snapshot?.transport === 'connecting' ? { transportStatus: 'checking' as const } : {}),
    remoteControl: entry?.remoteControl ?? entry?.status?.remoteControl ?? null
  })
}

const VERIFICATIONS = ['checking', 'verified', 'unavailable', 'blocked'] as const
const TRANSPORTS = ['unknown', 'connecting', 'ready', 'disconnected'] as const
const RETIRED = [false, true] as const
const REMOTE_CONTROL_STATES = [
  undefined,
  'ready',
  'awaiting_ready',
  'awaiting_authenticated',
  'reconnecting',
  'closed'
] as const

function makeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    runtimeId: 'rt-1',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    liveTabCount: 0,
    liveLeafCount: 0,
    ...overrides
  }
}

function makeRemoteControl(
  state: Exclude<(typeof REMOTE_CONTROL_STATES)[number], undefined>
): NonNullable<RuntimeStatus['remoteControl']> {
  return {
    state,
    pendingRequestCount: 0,
    subscriptionCount: 0,
    reconnectAttempt: 0,
    lastConnectedAt: null,
    lastClose: null,
    lastError: null
  }
}

function makeSnapshot(
  verification: (typeof VERIFICATIONS)[number],
  transport: (typeof TRANSPORTS)[number],
  retired: boolean,
  answered: RuntimeStatus | null
): RuntimeHostStatusSnapshot {
  return {
    environmentId: 'env-a',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    status: answered,
    verification,
    transport,
    ...(retired ? { retired: true as const } : {})
  }
}

/** Every entry shape the derivation can distinguish: 4 x 4 x 2, across each status/diagnostic. */
function* everySnapshotEntry(): Generator<{ label: string; entry: Entry }> {
  for (const verification of VERIFICATIONS) {
    for (const transport of TRANSPORTS) {
      for (const retired of RETIRED) {
        for (const answered of [null, makeStatus()] as const) {
          for (const remoteControlState of REMOTE_CONTROL_STATES) {
            // The store nulls `status` for anything but a verified, unretired probe, so the two
            // reachable pairings are the ones enumerated here rather than a free cross-product.
            const entryStatus = verification === 'verified' && !retired ? answered : null
            const remoteControl = remoteControlState
              ? makeRemoteControl(remoteControlState)
              : undefined
            yield {
              label: `${verification}/${transport}/retired=${retired}/answered=${answered !== null}/rc=${remoteControlState ?? 'none'}`,
              entry: {
                status: entryStatus,
                ...(remoteControl ? { remoteControl } : {}),
                snapshot: makeSnapshot(verification, transport, retired, answered)
              }
            }
          }
        }
      }
    }
  }
}

describe('the host contact changes no verdict', () => {
  it('agrees with the frozen derivation on every snapshot combination', () => {
    const cases = [...everySnapshotEntry()]
    // Guard against the enumeration silently collapsing: 4 x 4 x 2 x 2 x 6.
    expect(cases).toHaveLength(384)
    const disagreements = cases
      .map(({ label, entry }) => ({
        label,
        now: runtimeHostConnectionStateForEntry(entry),
        before: legacyRuntimeHostConnectionStateForEntry(entry)
      }))
      .filter(({ now, before }) => now !== before)
    expect(disagreements).toEqual([])
  })

  it('agrees for entries that carry no snapshot at all', () => {
    const entries: (Entry | null | undefined)[] = [
      null,
      undefined,
      { status: null },
      { status: makeStatus() },
      { status: null, remoteControl: makeRemoteControl('closed') },
      { status: null, remoteControl: makeRemoteControl('ready') },
      { status: makeStatus({ remoteControl: makeRemoteControl('reconnecting') }) }
    ]
    for (const entry of entries) {
      expect(runtimeHostConnectionStateForEntry(entry)).toBe(
        legacyRuntimeHostConnectionStateForEntry(entry)
      )
    }
  })

  it('keeps the revoked predicate and the contact verdict in step', () => {
    for (const { label, entry } of everySnapshotEntry()) {
      expect(
        isRuntimeHostContactRevokedVerdict(
          runtimeHostContactFromSnapshot(entry.snapshot!, entry.status)
        ),
        label
      ).toBe(isRuntimeHostContactRevoked(entry))
    }
  })
})

describe('the contact separates what the host said from what it is worth', () => {
  it('retains the host answer through every non-live verdict', () => {
    const answered = makeStatus()
    for (const [verification, transport, retired] of [
      ['unavailable', 'ready', false],
      ['checking', 'connecting', false],
      ['unavailable', 'disconnected', false],
      ['blocked', 'ready', false],
      ['verified', 'ready', true]
    ] as const) {
      const contact = runtimeHostContactFromSnapshot(
        makeSnapshot(verification, transport, retired, answered),
        null
      )
      expect(contact.verdict, `${verification}/${transport}`).not.toBe('live')
      // The fact the host gave us survives; only its currency is in question.
      expect(lastRuntimeHostAnswer(contact)).toBe(answered)
      expect(liveRuntimeHostStatus(contact)).toBeNull()
    }
  })

  it('reports a verified probe as live and nothing else', () => {
    const answered = makeStatus()
    const contact = runtimeHostContactFromSnapshot(
      makeSnapshot('verified', 'ready', false, answered),
      answered
    )
    expect(contact.verdict).toBe('live')
    expect(liveRuntimeHostStatus(contact)).toBe(answered)
    expect(lastRuntimeHostAnswer(contact)).toBe(answered)
  })

  it('tells a host that was never reached apart from a handshake in flight', () => {
    // These collapsed into one `null` before, and they want opposite affordances: one should
    // offer Connect, the other should not.
    expect(
      runtimeHostContactFromSnapshot(makeSnapshot('unavailable', 'unknown', false, null), null)
    ).toEqual({ verdict: 'unverifiable', reason: 'never-asked', lastAnswer: null })
    expect(
      runtimeHostContactFromSnapshot(makeSnapshot('unavailable', 'connecting', false, null), null)
    ).toEqual({ verdict: 'unverifiable', reason: 'transport-connecting', lastAnswer: null })
  })

  it('tells a refused host apart from a retired pairing', () => {
    const answered = makeStatus()
    expect(
      runtimeHostContactFromSnapshot(makeSnapshot('blocked', 'ready', false, answered), null)
        .verdict
    ).toBe('refused')
    expect(
      runtimeHostContactFromSnapshot(makeSnapshot('verified', 'ready', true, answered), null)
        .verdict
    ).toBe('retired')
  })
})
