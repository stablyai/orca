import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
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

  it('does not invent a capability the host never advertised', () => {
    expect(
      selectPairedRuntimeParkingEnvironmentIds(
        new Map([[ENVIRONMENT_ID, { status: null, snapshot: verifiedSnapshot({ status: null }) }]])
      )
    ).toEqual(new Set())
  })

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
