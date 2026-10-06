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

type Entry = {
  status: RuntimeStatus | null
  remoteControl?: RuntimeStatus['remoteControl'] | null
  snapshot?: RuntimeHostStatusSnapshot
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

describe('the revoked predicate and the contact verdict stay in step', () => {
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
