// @vitest-environment happy-dom

/**
 * Defect under test: the restored workspace surface used to wait for the whole
 * startup chain (SSH reconnect, PTY reconnect, legacy worker recovery) before it
 * mounted, so a session whose tab model had been in the store for seconds painted
 * nothing at all. Only terminal panes need that chain — they bind a PTY on mount.
 * The surface now mounts on the tab model, and terminal tabs are held unadmitted
 * until the gate opens and the activation plan replaces the hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { applyTerminalColdActivation } from '../terminal-cold-activation'
import { useActivationDeferredTabAdmission } from './use-activation-deferred-tab-admission'
import {
  pruneClosedBackgroundMountTabs,
  revealActivationDeferredTabs,
  shouldMountBackgroundWorktreeTab
} from './background-terminal-worktree-mount'
import {
  holdTerminalTabsForStartup,
  releaseStartupTerminalTabHold,
  selectParkedEquivalentMountTabIds,
  type StartupTerminalTabHold
} from './startup-terminal-tab-hold'
import type { TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalParkingFoundation } from '../use-terminal-parking-foundation'

const WORKTREE_ID = 'repo::/worktree'
const OTHER_WORKTREE_ID = 'repo::/other-worktree'
const TAB_1 = 'tab-1'
const TAB_2 = 'tab-2'
const GROUP_ID = 'group-1'
const SURFACE_IDS = [WORKTREE_ID, OTHER_WORKTREE_ID]

const initialState = useAppStore.getInitialState()
const originalRequestIdle = globalThis.requestIdleCallback
const originalCancelIdle = globalThis.cancelIdleCallback

function terminalTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: `${worktreeId}@@${id}`,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function leafLayout(worktreeId: string): {
  groups: TabGroup[]
  layout: TabGroupLayoutNode
} {
  return {
    groups: [
      { id: GROUP_ID, worktreeId, activeTabId: TAB_1, tabOrder: [TAB_1, TAB_2], recentTabIds: [] }
    ],
    layout: { type: 'leaf', groupId: GROUP_ID }
  }
}

type HarnessProps = { worktreeId: string | null; gateOpen: boolean }

/** Mirrors use-terminal-controller.ts: cold activation during render, then admission. */
function useStartupHoldHarness(props: HarnessProps) {
  const backgroundMountTabIdsByWorktreeRef = useRef(new Map<string, ReadonlySet<string>>())
  const activationDeferredMountTabIdsByWorktreeRef = useRef(new Map<string, ReadonlySet<string>>())
  const lastActivationWorktreeIdRef = useRef<string | null>(null)
  const startupTerminalTabHoldRef = useRef<StartupTerminalTabHold | null>(null)
  const mountedWorktreeIdsRef = useRef(new Set<string>())
  const activationDeferralPlanRevisionRef = useRef(0)
  const [backgroundMountRevision, setBackgroundMountRevision] = useState(0)
  const restored = leafLayout(props.worktreeId ?? WORKTREE_ID)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: applyTerminalColdActivation and the admission hook read only the fields listed here; the rest of the foundation is render machinery this harness never exercises.
  const foundation = {
    activationDeferralPlanRevisionRef,
    activationDeferredMountTabIdsByWorktreeRef,
    activeGroupIdByWorktree: props.worktreeId ? { [props.worktreeId]: GROUP_ID } : {},
    activeTabId: TAB_1,
    activeTabIdByWorktree: props.worktreeId ? { [props.worktreeId]: TAB_1 } : {},
    activeWorktreeDeferralHostId: 'local',
    activityTerminalPortals: [],
    backgroundMountRevision,
    backgroundMountTabIdsByWorktreeRef,
    groupsByWorktree: props.worktreeId ? { [props.worktreeId]: restored.groups } : {},
    hydrationSucceeded: props.gateOpen,
    lastActivationWorktreeIdRef,
    layoutByWorktree: props.worktreeId ? { [props.worktreeId]: restored.layout } : {},
    mountedWorktreeIdsRef,
    pairedRuntimeParkingEnvironmentIds: new Set<string>(),
    pendingStartupByTabId: {},
    renderedActiveWorktreeId: props.worktreeId,
    setBackgroundMountRevision,
    startupTerminalTabHoldRef,
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
  return {
    activationDeferredMountTabIdsByWorktreeRef,
    anyMountedWorktreeHasLayout: coldActivation.anyMountedWorktreeHasLayout,
    backgroundMountTabIdsByWorktreeRef,
    mountedWorktreeIdsRef,
    startupTerminalTabHold: coldActivation.startupTerminalTabHold
  }
}

function admits(
  restrictions: Map<string, ReadonlySet<string>>,
  worktreeId: string,
  tabId: string
): boolean {
  return shouldMountBackgroundWorktreeTab(restrictions.get(worktreeId) ?? null, tabId)
}

describe('startup terminal tab hold', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [terminalTab(TAB_1, WORKTREE_ID), terminalTab(TAB_2, WORKTREE_ID)],
        [OTHER_WORKTREE_ID]: [terminalTab(TAB_1, OTHER_WORKTREE_ID)]
      }
    })
    // Deterministic drain: force scheduleActivationDeferredAdmission onto timers.
    // @ts-expect-error -- exercising the no-requestIdleCallback environment
    globalThis.requestIdleCallback = undefined
    // @ts-expect-error -- exercising the no-requestIdleCallback environment
    globalThis.cancelIdleCallback = undefined
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    globalThis.requestIdleCallback = originalRequestIdle
    globalThis.cancelIdleCallback = originalCancelIdle
    useAppStore.setState(initialState, true)
  })

  it('mounts the restored surface before the gate opens and holds every terminal tab', () => {
    const { result, rerender } = renderHook(useStartupHoldHarness, {
      initialProps: { worktreeId: WORKTREE_ID, gateOpen: false }
    })
    const restrictions = result.current.backgroundMountTabIdsByWorktreeRef.current

    // The surface mounts from the tab model alone...
    expect(result.current.mountedWorktreeIdsRef.current.has(WORKTREE_ID)).toBe(true)
    expect(result.current.anyMountedWorktreeHasLayout).toBe(true)
    // ...while no terminal pane may bind a PTY yet, and none is idle-admission work.
    expect(admits(restrictions, WORKTREE_ID, TAB_1)).toBe(false)
    expect(admits(restrictions, WORKTREE_ID, TAB_2)).toBe(false)
    expect(result.current.activationDeferredMountTabIdsByWorktreeRef.current.has(WORKTREE_ID)).toBe(
      false
    )
    // Held tabs stay parked-equivalent, so watchers own their bells, titles, and completions.
    expect(result.current.startupTerminalTabHold).toEqual({
      worktreeId: WORKTREE_ID,
      heldTabIds: new Set([TAB_1, TAB_2])
    })
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(admits(restrictions, WORKTREE_ID, TAB_1)).toBe(false)

    // The gate opening runs the activation plan, which replaces the hold.
    rerender({ worktreeId: WORKTREE_ID, gateOpen: true })
    expect(result.current.mountedWorktreeIdsRef.current.has(WORKTREE_ID)).toBe(true)
    expect(admits(restrictions, WORKTREE_ID, TAB_1)).toBe(true)
    expect(admits(restrictions, WORKTREE_ID, TAB_2)).toBe(true)
    expect(result.current.startupTerminalTabHold).toBeNull()
  })

  it('returns a workspace switched away from mid-startup to the unmounted world', () => {
    const { result, rerender } = renderHook(useStartupHoldHarness, {
      initialProps: { worktreeId: WORKTREE_ID, gateOpen: false }
    })
    expect(result.current.mountedWorktreeIdsRef.current.has(WORKTREE_ID)).toBe(true)

    rerender({ worktreeId: OTHER_WORKTREE_ID, gateOpen: false })
    const restrictions = result.current.backgroundMountTabIdsByWorktreeRef.current
    expect(result.current.mountedWorktreeIdsRef.current.has(WORKTREE_ID)).toBe(false)
    expect(restrictions.has(WORKTREE_ID)).toBe(false)
    expect(result.current.mountedWorktreeIdsRef.current.has(OTHER_WORKTREE_ID)).toBe(true)
    expect(admits(restrictions, OTHER_WORKTREE_ID, TAB_1)).toBe(false)

    rerender({ worktreeId: OTHER_WORKTREE_ID, gateOpen: true })
    expect(admits(restrictions, OTHER_WORKTREE_ID, TAB_1)).toBe(true)
  })

  it('returns a workspace left for no workspace mid-startup to the unmounted world', () => {
    const initialProps: HarnessProps = { worktreeId: WORKTREE_ID, gateOpen: false }
    const { result, rerender } = renderHook(useStartupHoldHarness, { initialProps })
    expect(result.current.mountedWorktreeIdsRef.current.has(WORKTREE_ID)).toBe(true)

    rerender({ worktreeId: null, gateOpen: false })
    expect(result.current.mountedWorktreeIdsRef.current.has(WORKTREE_ID)).toBe(false)
    expect(result.current.backgroundMountTabIdsByWorktreeRef.current.has(WORKTREE_ID)).toBe(false)
    expect(result.current.startupTerminalTabHold).toBeNull()

    rerender({ worktreeId: null, gateOpen: true })
    expect(result.current.mountedWorktreeIdsRef.current.size).toBe(0)
  })

  it('keeps holding a widened hold whose targeted tab closed', () => {
    const { result, rerender } = renderHook(useStartupHoldHarness, {
      initialProps: { worktreeId: WORKTREE_ID, gateOpen: false }
    })
    const restrictions = result.current.backgroundMountTabIdsByWorktreeRef.current
    // A targeted background mount widens the hold to its tab.
    restrictions.set(WORKTREE_ID, new Set([TAB_1]))
    act(() => {
      useAppStore.setState({
        tabsByWorktree: {
          ...useAppStore.getState().tabsByWorktree,
          [WORKTREE_ID]: [terminalTab(TAB_2, WORKTREE_ID)]
        }
      })
    })
    rerender({ worktreeId: WORKTREE_ID, gateOpen: false })

    expect(result.current.mountedWorktreeIdsRef.current.has(WORKTREE_ID)).toBe(true)
    expect(admits(restrictions, WORKTREE_ID, TAB_2)).toBe(false)
    expect(result.current.startupTerminalTabHold?.heldTabIds).toEqual(new Set([TAB_2]))
  })

  it('does not mount a surface with no active workspace', () => {
    const { result } = renderHook(useStartupHoldHarness, {
      initialProps: { worktreeId: null, gateOpen: false }
    })
    expect(result.current.mountedWorktreeIdsRef.current.size).toBe(0)
    expect(result.current.backgroundMountTabIdsByWorktreeRef.current.size).toBe(0)
  })
})

describe('holdTerminalTabsForStartup', () => {
  it('admits no terminal tab of a worktree that has not mounted yet', () => {
    const hold: { current: StartupTerminalTabHold | null } = { current: null }
    const restrictions = new Map<string, ReadonlySet<string>>()
    const mounted = new Set<string>()

    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-active', ['tab-1'])

    expect(restrictions.get('wt-active')).toEqual(new Set())
    expect(mounted.has('wt-active')).toBe(true)
    expect(shouldMountBackgroundWorktreeTab(restrictions.get('wt-active') ?? null, 'tab-1')).toBe(
      false
    )
    expect(hold.current).toEqual({ worktreeId: 'wt-active', heldTabIds: new Set(['tab-1']) })
  })

  it('keeps a targeted background mount that landed first and never narrows a full mount', () => {
    const hold: { current: StartupTerminalTabHold | null } = { current: null }
    const restrictions = new Map<string, ReadonlySet<string>>([['wt-active', new Set(['tab-1'])]])
    const mounted = new Set<string>(['wt-full'])

    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-active', ['tab-1', 'tab-2'])
    expect(restrictions.get('wt-active')).toEqual(new Set(['tab-1']))
    expect(hold.current?.heldTabIds).toEqual(new Set(['tab-2']))

    releaseStartupTerminalTabHold(hold, restrictions, mounted, 'wt-full')
    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-full', ['tab-1'])
    expect(restrictions.has('wt-full')).toBe(false)
    expect(hold.current?.heldTabIds).toEqual(new Set())
  })

  it('keeps the held set identity while the hold is unchanged', () => {
    const hold: { current: StartupTerminalTabHold | null } = { current: null }
    const restrictions = new Map<string, ReadonlySet<string>>()
    const mounted = new Set<string>()
    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-active', ['tab-1'])
    const first = hold.current

    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-active', ['tab-1'])

    expect(hold.current).toBe(first)
  })

  it('survives prune and reveal passes untouched', () => {
    const hold: { current: StartupTerminalTabHold | null } = { current: null }
    const restrictions = new Map<string, ReadonlySet<string>>()
    const deferred = new Map<string, ReadonlySet<string>>()
    const mounted = new Set<string>()
    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-active', ['tab-1'])

    expect(
      pruneClosedBackgroundMountTabs(
        restrictions,
        mounted,
        { 'wt-active': [{ id: 'tab-1' }] },
        deferred
      )
    ).toBe(false)
    revealActivationDeferredTabs({
      restrictions,
      deferredMountTabIdsByWorktree: deferred,
      worktreeId: 'wt-active',
      allTabIds: ['tab-1'],
      immediateTabIds: new Set(['tab-1'])
    })
    expect(restrictions.get('wt-active')).toEqual(new Set())
    expect(mounted.has('wt-active')).toBe(true)
  })

  it('releases an unwidened hold and leaves a widened one as a targeted restriction', () => {
    const hold: { current: StartupTerminalTabHold | null } = { current: null }
    const restrictions = new Map<string, ReadonlySet<string>>()
    const mounted = new Set<string>()
    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-previous', ['tab-1'])

    releaseStartupTerminalTabHold(hold, restrictions, mounted, 'wt-previous')
    expect(hold.current?.worktreeId).toBe('wt-previous')

    releaseStartupTerminalTabHold(hold, restrictions, mounted, null)
    expect(restrictions.has('wt-previous')).toBe(false)
    expect(mounted.has('wt-previous')).toBe(false)
    expect(hold.current).toBeNull()

    holdTerminalTabsForStartup(hold, restrictions, mounted, 'wt-targeted', ['tab-wake', 'tab-2'])
    restrictions.set('wt-targeted', new Set(['tab-wake']))
    releaseStartupTerminalTabHold(hold, restrictions, mounted, 'wt-active')
    expect(restrictions.get('wt-targeted')).toEqual(new Set(['tab-wake']))
    expect(mounted.has('wt-targeted')).toBe(true)
  })
})

describe('selectParkedEquivalentMountTabIds', () => {
  const hold: StartupTerminalTabHold = { worktreeId: 'wt-held', heldTabIds: new Set(['tab-1']) }

  it('prefers the activation deferral, then the hold, for the held worktree only', () => {
    const deferred = new Set(['tab-deferred'])
    expect(selectParkedEquivalentMountTabIds(deferred, hold, 'wt-held')).toBe(deferred)
    expect(selectParkedEquivalentMountTabIds(undefined, hold, 'wt-held')).toBe(hold.heldTabIds)
    expect(selectParkedEquivalentMountTabIds(undefined, hold, 'wt-other')).toBeNull()
    expect(selectParkedEquivalentMountTabIds(undefined, null, 'wt-held')).toBeNull()
  })
})
