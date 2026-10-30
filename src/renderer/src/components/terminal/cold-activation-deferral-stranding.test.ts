// @vitest-environment happy-dom

/** Startup gate opening can install ref-only deferral without changing active workspace or mount revision. The plan revision must wake idle admission or every deferred tab remains stranded until a workspace switch. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { applyTerminalColdActivation } from '../terminal-cold-activation'
import { useActivationDeferredTabAdmission } from './use-activation-deferred-tab-admission'
import { shouldMountBackgroundWorktreeTab } from './background-terminal-worktree-mount'
import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities,
  terminalProviderHasAuthoritativeSnapshot
} from './terminal-provider-snapshot-capability'
import {
  canWatcherCoverParkedTerminalTab,
  captureParkedTerminalPaneCandidates
} from '../terminal-pane/terminal-parked-tab-watchers'
import { capturedPanesByTabId } from '../terminal-pane/terminal-parked-watcher-registry'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalParkingFoundation } from '../use-terminal-parking-foundation'
import type { StartupTerminalTabHold } from './startup-terminal-tab-hold'

const WORKTREE_ID = 'repo::/worktree'
const OTHER_WORKTREE_ID = 'repo::/other-worktree'
const TAB_1 = 'tab-1'
const TAB_2 = 'tab-2'
const PTY_1 = `${WORKTREE_ID}@@session-1`
const PTY_2 = `${WORKTREE_ID}@@session-2`
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const SURFACE_IDS = [WORKTREE_ID, OTHER_WORKTREE_ID]

const initialState = useAppStore.getInitialState()
const originalRequestIdle = globalThis.requestIdleCallback
const originalCancelIdle = globalThis.cancelIdleCallback

function terminalTab(id: string, ptyId: string): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

async function seedDeferrableWorktree(): Promise<void> {
  useAppStore.setState({
    tabsByWorktree: { [WORKTREE_ID]: [terminalTab(TAB_1, PTY_1), terminalTab(TAB_2, PTY_2)] }
  })
  captureParkedTerminalPaneCandidates(TAB_1, WORKTREE_ID, [
    { ptyId: PTY_1, paneId: 1, leafId: LEAF_1, drivesTabTitle: true }
  ])
  captureParkedTerminalPaneCandidates(TAB_2, WORKTREE_ID, [
    { ptyId: PTY_2, paneId: 2, leafId: LEAF_2, drivesTabTitle: true }
  ])
  await synchronizeTerminalProviderSnapshotCapabilities([PTY_1, PTY_2], async (ids) =>
    ids.map((id) => ({ id, authoritative: true }))
  )
}

type HarnessProps = { worktreeId: string | null; gateOpen: boolean }

function useStrandingHarness(props: HarnessProps) {
  const backgroundMountTabIdsByWorktreeRef = useRef(new Map<string, ReadonlySet<string>>())
  const activationDeferredMountTabIdsByWorktreeRef = useRef(new Map<string, ReadonlySet<string>>())
  const lastActivationWorktreeIdRef = useRef<string | null>(null)
  const startupTerminalTabHoldRef = useRef<StartupTerminalTabHold | null>(null)
  const mountedWorktreeIdsRef = useRef(new Set<string>())
  const activationDeferralPlanRevisionRef = useRef(0)
  const [backgroundMountRevision, setBackgroundMountRevision] = useState(0)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: applyTerminalColdActivation and the admission hook read only the fields listed here; the rest of the foundation is render machinery this harness never exercises.
  const foundation = {
    activationDeferralPlanRevisionRef,
    activationDeferredMountTabIdsByWorktreeRef,
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeWorktreeDeferralHostId: 'local',
    activityTerminalPortals: [],
    backgroundMountRevision,
    backgroundMountTabIdsByWorktreeRef,
    groupsByWorktree: {},
    hydrationSucceeded: props.gateOpen,
    lastActivationWorktreeIdRef,
    startupTerminalTabHoldRef,
    layoutByWorktree: {},
    mountedWorktreeIdsRef,
    pairedRuntimeParkingEnvironmentIds: new Set<string>(),
    pendingStartupByTabId: {},
    renderedActiveWorktreeId: props.worktreeId,
    setBackgroundMountRevision,
    startupWorktreeRefreshCompleted: props.gateOpen,
    tabsByWorktree: useAppStore.getState().tabsByWorktree,
    terminalParkingEnabled: true,
    terminalTitleSnapshotAuthorityEnabled: true,
    workspaceSessionReady: props.gateOpen,
    workspaceSurfaceIds: SURFACE_IDS,
    workspaceSurfaceIdSet: new Set(SURFACE_IDS)
  } as unknown as TerminalParkingFoundation
  const coldActivation = Object.assign(foundation, applyTerminalColdActivation(foundation))
  useActivationDeferredTabAdmission(coldActivation)
  return { activationDeferredMountTabIdsByWorktreeRef, backgroundMountTabIdsByWorktreeRef }
}

function drainIdleAdmissions(passes: number): void {
  for (let index = 0; index < passes; index += 1) {
    act(() => {
      vi.advanceTimersByTime(1)
    })
  }
}

describe('cold-activation deferral stranding', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    // Deterministic drain: force scheduleActivationDeferredAdmission onto timers.
    // @ts-expect-error -- exercising the no-requestIdleCallback environment
    globalThis.requestIdleCallback = undefined
    // @ts-expect-error -- exercising the no-requestIdleCallback environment
    globalThis.cancelIdleCallback = undefined
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    globalThis.requestIdleCallback = originalRequestIdle
    globalThis.cancelIdleCallback = originalCancelIdle
    clearTerminalProviderSnapshotCapabilities()
    capturedPanesByTabId.clear()
    useAppStore.setState(initialState, true)
  })

  it('precondition: both seeded tabs are deferrable under the real coverage predicate', async () => {
    await seedDeferrableWorktree()
    const [first, second] = useAppStore.getState().tabsByWorktree[WORKTREE_ID]!
    expect(
      canWatcherCoverParkedTerminalTab(
        WORKTREE_ID,
        first!,
        terminalProviderHasAuthoritativeSnapshot
      )
    ).toBe(true)
    expect(
      canWatcherCoverParkedTerminalTab(
        WORKTREE_ID,
        second!,
        terminalProviderHasAuthoritativeSnapshot
      )
    ).toBe(true)
  })

  it('drains a plan installed by the gate-open pass without the active worktree changing', async () => {
    await seedDeferrableWorktree()
    vi.useFakeTimers()
    const { result, rerender } = renderHook((props: HarnessProps) => useStrandingHarness(props), {
      initialProps: { worktreeId: WORKTREE_ID, gateOpen: false }
    })
    expect(result.current.activationDeferredMountTabIdsByWorktreeRef.current.size).toBe(0)

    rerender({ worktreeId: WORKTREE_ID, gateOpen: true })
    const restrictions = result.current.backgroundMountTabIdsByWorktreeRef.current
    const deferred = result.current.activationDeferredMountTabIdsByWorktreeRef.current
    expect(deferred.get(WORKTREE_ID)?.size).toBe(2)
    expect(shouldMountBackgroundWorktreeTab(restrictions.get(WORKTREE_ID) ?? null, TAB_1)).toBe(
      false
    )
    expect(shouldMountBackgroundWorktreeTab(restrictions.get(WORKTREE_ID) ?? null, TAB_2)).toBe(
      false
    )

    // Plan installation must wake admission without a workspace switch.
    drainIdleAdmissions(3)
    expect(deferred.has(WORKTREE_ID)).toBe(false)
    expect(shouldMountBackgroundWorktreeTab(restrictions.get(WORKTREE_ID) ?? null, TAB_1)).toBe(
      true
    )
    expect(shouldMountBackgroundWorktreeTab(restrictions.get(WORKTREE_ID) ?? null, TAB_2)).toBe(
      true
    )
  })

  it('control: the same stranded state drains when the active worktree bounces away and back', async () => {
    await seedDeferrableWorktree()
    vi.useFakeTimers()
    const { result, rerender } = renderHook((props: HarnessProps) => useStrandingHarness(props), {
      initialProps: { worktreeId: WORKTREE_ID, gateOpen: false }
    })
    rerender({ worktreeId: WORKTREE_ID, gateOpen: true })
    expect(
      result.current.activationDeferredMountTabIdsByWorktreeRef.current.get(WORKTREE_ID)?.size
    ).toBe(2)

    // Workspace bounce already changes a drain dependency; preserve that admission path too.
    rerender({ worktreeId: OTHER_WORKTREE_ID, gateOpen: true })
    rerender({ worktreeId: WORKTREE_ID, gateOpen: true })
    drainIdleAdmissions(3)
    const restrictions = result.current.backgroundMountTabIdsByWorktreeRef.current
    expect(result.current.activationDeferredMountTabIdsByWorktreeRef.current.has(WORKTREE_ID)).toBe(
      false
    )
    expect(shouldMountBackgroundWorktreeTab(restrictions.get(WORKTREE_ID) ?? null, TAB_1)).toBe(
      true
    )
    expect(shouldMountBackgroundWorktreeTab(restrictions.get(WORKTREE_ID) ?? null, TAB_2)).toBe(
      true
    )
  })
})
