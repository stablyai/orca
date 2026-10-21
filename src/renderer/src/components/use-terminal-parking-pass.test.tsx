// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'
import { useTerminalParkingPass } from './use-terminal-parking-pass'

const parkingPass = vi.hoisted(() => ({ parkedIds: ['wt-parked'] }))

vi.mock('./terminal-parking-pass-candidates', () => ({
  canOrdinarilyParkRetentionCandidate: () => true,
  collectTerminalParkingPassCandidates: () => ({
    retentionCandidates: [],
    // Fresh Set each pass, like the real selector.
    nextParkedTerminalWorktreeIds: new Set(parkingPass.parkedIds),
    nowMs: 0,
    overrides: {},
    parkingTimers: new Map()
  })
}))
vi.mock('./terminal-pane/parked-terminal-buffer-capture', () => ({
  captureParkedTerminalBuffers: () => true
}))

function useParkingPassHost() {
  // Why own state: like the workbench's store subscriptions, an update on this fiber leaves lanes on
  // its alternate, which defeats React's eager same-state bailout for the setters below.
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

  it('does not queue a render when a pass produces the same parking sets', () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useParkingPassHost()
    })
    expect([...result.current.parked]).toEqual(['wt-parked'])

    // Why: during a worktree removal every pty-exit commit re-runs this pass; each no-op render it
    // queued kept React's nested-update counter climbing until #185.
    const settled = renders
    for (let i = 0; i < 5; i++) {
      act(() => result.current.bump())
    }
    expect(renders - settled).toBe(5)
    expect([...result.current.parked]).toEqual(['wt-parked'])
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

  it('keeps parking transitions working under StrictMode', () => {
    const { result } = renderHook(() => useParkingPassHost(), { wrapper: StrictMode })
    expect([...result.current.parked]).toEqual(['wt-parked'])
    parkingPass.parkedIds = []
    act(() => result.current.bump())
    expect([...result.current.parked]).toEqual([])
    parkingPass.parkedIds = ['wt-parked']
    act(() => result.current.bump())
    expect([...result.current.parked]).toEqual(['wt-parked'])
  })
})
