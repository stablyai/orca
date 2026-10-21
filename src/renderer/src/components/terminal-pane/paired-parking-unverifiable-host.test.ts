import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { runtimeHostConnectionStateForEntry } from '@/runtime/runtime-host-connection-state'
import {
  resetPairedRuntimeParkingEnvironmentIdsCacheForTest,
  selectPairedRuntimeParkingEnvironmentIds
} from './paired-runtime-parking-capabilities'

const ENVIRONMENT_ID = 'runtime-a'

const getState = vi.fn()
vi.mock('@/store', () => ({ useAppStore: { getState: () => getState() } }))
vi.mock('@/runtime/runtime-terminal-stream', () => ({
  getRemoteRuntimePtyEnvironmentId: (ptyId: string) =>
    ptyId.startsWith('remote:') ? ptyId.slice('remote:'.length).split('/')[0] : null
}))

/** The capability the host answered with while it was still reachable. */
function verifiedSnapshot(
  overrides: Partial<RuntimeHostStatusSnapshot> = {}
): RuntimeHostStatusSnapshot {
  return {
    environmentId: ENVIRONMENT_ID,
    pairingRevision: 1,
    sequence: 2,
    checkedAt: 2,
    status: {
      runtimeId: 'r1',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: 1,
      liveTabCount: 0,
      liveLeafCount: 0,
      capabilities: [TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY]
    },
    verification: 'unavailable',
    transport: 'connecting',
    ...overrides
  }
}

describe('paired parking capability through an unverifiable probe', () => {
  beforeEach(() => {
    resetPairedRuntimeParkingEnvironmentIdsCacheForTest()
  })

  it('keeps the environment capable when the probe nulled the entry status', () => {
    expect(
      selectPairedRuntimeParkingEnvironmentIds(
        new Map([[ENVIRONMENT_ID, { status: null, snapshot: verifiedSnapshot() }]])
      )
    ).toEqual(new Set([ENVIRONMENT_ID]))
  })

  // The other half of the gate: it must fire on the host's own terminal verdict and on nothing
  // else. Firing on a flap strands every hidden tab mounted, which is the churn this PR removes.
  it.each([
    ['checking', { verification: 'checking' } as const, 'checking'],
    ['reconnecting', { transport: 'disconnected' } as const, 'reconnecting'],
    ['runtime-unavailable', { transport: 'ready' } as const, 'runtime-unavailable']
  ])('keeps a %s host capable', (_label, patch, expectedState) => {
    const entry = { status: null, snapshot: verifiedSnapshot(patch) }
    expect(runtimeHostConnectionStateForEntry(entry)).toBe(expectedState)
    expect(selectPairedRuntimeParkingEnvironmentIds(new Map([[ENVIRONMENT_ID, entry]]))).toEqual(
      new Set([ENVIRONMENT_ID])
    )
  })

  it('does not invent a capability the host never advertised', () => {
    expect(
      selectPairedRuntimeParkingEnvironmentIds(
        new Map([[ENVIRONMENT_ID, { status: null, snapshot: verifiedSnapshot({ status: null }) }]])
      )
    ).toEqual(new Set())
  })

  // Parking unmounts the pane and discards the client's only copy of the scrollback, trading it
  // for a host-side restore. A refused host retries nothing ever again, so that restore cannot
  // happen — keeping it "capable" spends the scrollback on a promise no one can keep.
  it.each(['blocked', 'retired'] as const)(
    'drops a %s host that can no longer honour a restore',
    (kind) => {
      expect(
        selectPairedRuntimeParkingEnvironmentIds(
          new Map([
            [
              ENVIRONMENT_ID,
              {
                status: null,
                snapshot: verifiedSnapshot(
                  kind === 'blocked' ? { verification: 'blocked' } : { retired: true }
                )
              }
            ]
          ])
        )
      ).toEqual(new Set())
    }
  )

  it('still reads a live entry with no snapshot', () => {
    expect(
      selectPairedRuntimeParkingEnvironmentIds(
        new Map([
          [
            ENVIRONMENT_ID,
            { status: { capabilities: [TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY] } }
          ]
        ])
      )
    ).toEqual(new Set([ENVIRONMENT_ID]))
  })
})

describe('paired parked terminal restore through an unverifiable probe', () => {
  it('keeps the parked session reattachable when the probe nulled the entry status', async () => {
    const { canRestorePairedParkedTerminal } =
      await import('./pty-connection/paired-parked-terminal-restore')
    getState.mockReturnValue({
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: null, snapshot: verifiedSnapshot() }]
      ])
    })
    expect(canRestorePairedParkedTerminal(`remote:${ENVIRONMENT_ID}/pty-1`)).toBe(true)
  })

  it.each(['blocked', 'retired'] as const)('refuses a %s host', async (kind) => {
    const { canRestorePairedParkedTerminal } =
      await import('./pty-connection/paired-parked-terminal-restore')
    getState.mockReturnValue({
      runtimeStatusByEnvironmentId: new Map([
        [
          ENVIRONMENT_ID,
          {
            status: null,
            snapshot: verifiedSnapshot(
              kind === 'blocked' ? { verification: 'blocked' } : { retired: true }
            )
          }
        ]
      ])
    })
    expect(canRestorePairedParkedTerminal(`remote:${ENVIRONMENT_ID}/pty-1`)).toBe(false)
  })

  it('refuses a host that never advertised the capability', async () => {
    const { canRestorePairedParkedTerminal } =
      await import('./pty-connection/paired-parked-terminal-restore')
    getState.mockReturnValue({
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: null, snapshot: verifiedSnapshot({ status: null }) }]
      ])
    })
    expect(canRestorePairedParkedTerminal(`remote:${ENVIRONMENT_ID}/pty-1`)).toBe(false)
  })
})
