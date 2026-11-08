// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'
import { useTerminalParkingPass } from './use-terminal-parking-pass'

const parkingPass = vi.hoisted(() => ({ parkedIds: ['wt-parked'] }))

vi.mock('./terminal-parking-pass-candidates', () => ({
  canOrdinarilyParkRetentionCandidate: () => true,
  collectTerminalParkingPassCandidates: () => ({
    retentionCandidates: [],
    nextParkedTerminalWorktreeIds: new Set(parkingPass.parkedIds),
    nowMs: 0,
    overrides: {},
    parkingTimers: new Map()
  })
}))
vi.mock('./terminal-pane/parking/capture/parked-terminal-buffer-capture', () => ({
  captureParkedTerminalBuffers: () => true
}))

function useParkingPassHost() {
  // Give this fiber state updates so pending alternate lanes defeat React’s eager same-state bailout, as real subscriptions do.
  const [revision, setRevision] = useState(0)
  const [parked, setParked] = useState<ReadonlySet<string>>(() => new Set())
  const [forceParked, setForceParked] = useState<ReadonlySet<string>>(() => new Set())
  const [exempt, setExempt] = useState<ReadonlySet<string>>(() => new Set())
  const controller = {
    activeView: 'terminal',
    activityTerminalPortals: [],
    backgroundMountRevision: 0,
    parkedCaptureDoneRef: { current: new Set<string>() },
    pairedRuntimeParkingEnvironmentIds: [],
    pendingStartupByTabId: {},
    renderedActiveWorktreeId: 'wt-active',
    setEvictionExemptTerminalTabIds: setExempt,
    setForceParkedTerminalWorktreeIds: setForceParked,
    setParkedTerminalWorktreeIds: setParked,
    setTerminalParkingRevision: () => {},
    tabsByWorktree: {},
    terminalParkingEnabled: true,
    terminalParkingRevision: revision,
    terminalProviderSnapshotCapabilityRevision: 0,
    terminalRetentionBudgetEnabled: false,
    terminalSshParkingEnabled: false,
    workspaceSurfaceIds: []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass reads only the fields stubbed above.
  useTerminalParkingPass(controller as unknown as TerminalParkingFoundation)
  return { parked, forceParked, exempt, bump: () => setRevision((r) => r + 1) }
}

describe('useTerminalParkingPass', () => {
  beforeEach(() => {
    parkingPass.parkedIds = ['wt-parked']
  })

  it('applies changed parking decisions after unchanged passes', () => {
    const { result } = renderHook(() => useParkingPassHost())
    act(() => result.current.bump())
    parkingPass.parkedIds = ['wt-other']
    act(() => result.current.bump())
    expect([...result.current.parked]).toEqual(['wt-other'])
    parkingPass.parkedIds = []
    act(() => result.current.bump())
    expect([...result.current.parked]).toEqual([])
  })
})
