import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../store'
import { applyTerminalColdActivation } from './terminal-cold-activation'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'
import type { TerminalTab } from '../../../shared/workspace-layout/terminal-tab-types'
import {
  isActivationAdmissionEligible,
  pickNextActivationDeferredTabId
} from './terminal/activation-deferred-tab-admission'
import { isUnboundRestoredTerminalTab } from './terminal/unbound-restored-terminal-tab'

const WORKTREE = 'repo::/wt'

function tab(id: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: WORKTREE,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...extra
  }
}

function controllerFor(
  tabs: TerminalTab[],
  overrides: Partial<Record<keyof TerminalParkingFoundation, unknown>> = {}
): TerminalParkingFoundation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cold activation reads only the fields listed here; the rest of the hook controller is React state it never touches.
  return {
    activationDeferralPlanRevisionRef: { current: 0 },
    activationDeferredMountTabIdsByWorktreeRef: { current: new Map() },
    activeGroupIdByWorktree: {},
    activeTabId: tabs[0]?.id ?? null,
    activeTabIdByWorktree: {},
    activeWorktreeDeferralHostId: 'local',
    activityTerminalPortals: [],
    backgroundMountTabIdsByWorktreeRef: { current: new Map() },
    groupsByWorktree: {},
    hydrationSucceeded: true,
    lastActivationWorktreeIdRef: { current: null },
    layoutByWorktree: {},
    mountedWorktreeIdsRef: { current: new Set() },
    pairedRuntimeParkingEnvironmentIds: new Set(),
    pendingStartupByTabId: {},
    renderedActiveWorktreeId: WORKTREE,
    startupTerminalTabHoldRef: { current: null },
    startupWorktreeRefreshCompleted: true,
    tabsByWorktree: { [WORKTREE]: tabs },
    terminalParkingEnabled: false,
    terminalTitleSnapshotAuthorityEnabled: false,
    workspaceSessionReady: true,
    workspaceSurfaceIds: [WORKTREE],
    workspaceSurfaceIdSet: new Set([WORKTREE]),
    ...overrides
  } as unknown as TerminalParkingFoundation
}

function deadAgentTabs(count: number): TerminalTab[] {
  return Array.from({ length: count }, (_, index) =>
    tab(`tab-${index}`, { launchAgent: 'claude', restoredFromSession: true })
  )
}

function mountableTabIds(controller: TerminalParkingFoundation): string[] {
  const allowed = controller.backgroundMountTabIdsByWorktreeRef.current.get(WORKTREE)
  const tabs = controller.tabsByWorktree[WORKTREE] ?? []
  return tabs.filter((t) => !allowed || allowed.has(t.id)).map((t) => t.id)
}

describe('cold activation of a worktree with unbound saved tabs (#39166)', () => {
  beforeEach(() => {
    useAppStore.setState({
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      pendingStartupByTabId: {},
      unifiedTabsByWorktree: {}
    })
  })

  it('mounts only the visible tab when many saved agent tabs have no PTY', () => {
    const tabs = deadAgentTabs(97)
    useAppStore.setState({ tabsByWorktree: { [WORKTREE]: tabs } })
    const controller = controllerFor(tabs)

    applyTerminalColdActivation(controller)

    expect(mountableTabIds(controller)).toEqual(['tab-0'])
    const deferred = controller.activationDeferredMountTabIdsByWorktreeRef.current.get(WORKTREE)
    expect(deferred?.size).toBe(96)
    // Over the cap, the idle pass admits none; each waits until the user opens it.
    expect(isActivationAdmissionEligible(deferred?.size ?? 0)).toBe(false)
  })

  it('opening a held tab mounts it without releasing the others', () => {
    const tabs = deadAgentTabs(10)
    useAppStore.setState({ tabsByWorktree: { [WORKTREE]: tabs } })
    const controller = controllerFor(tabs)
    applyTerminalColdActivation(controller)

    const clicked = controllerFor(tabs, {
      activeTabId: 'tab-7',
      backgroundMountTabIdsByWorktreeRef: controller.backgroundMountTabIdsByWorktreeRef,
      activationDeferredMountTabIdsByWorktreeRef:
        controller.activationDeferredMountTabIdsByWorktreeRef,
      lastActivationWorktreeIdRef: controller.lastActivationWorktreeIdRef,
      mountedWorktreeIdsRef: controller.mountedWorktreeIdsRef
    })
    applyTerminalColdActivation(clicked)

    expect(mountableTabIds(clicked)).toEqual(['tab-0', 'tab-7'])
  })

  it('keeps the capped idle warm-up for a few unbound tabs', () => {
    const tabs = deadAgentTabs(3)
    useAppStore.setState({ tabsByWorktree: { [WORKTREE]: tabs } })
    const controller = controllerFor(tabs)
    applyTerminalColdActivation(controller)

    const deferred = controller.activationDeferredMountTabIdsByWorktreeRef.current.get(WORKTREE)
    expect(isActivationAdmissionEligible(deferred?.size ?? 0)).toBe(true)
    expect(
      pickNextActivationDeferredTabId(
        tabs.map((t) => t.id),
        deferred
      )
    ).toBe('tab-1')
  })

  it('mounts a held tab once its PTY binds', () => {
    const tabs = deadAgentTabs(6)
    useAppStore.setState({ tabsByWorktree: { [WORKTREE]: tabs } })
    const controller = controllerFor(tabs)
    applyTerminalColdActivation(controller)

    const bound = tabs.map((t) =>
      t.id === 'tab-3' ? { ...t, ptyId: 'pty-3', restoredFromSession: undefined } : t
    )
    useAppStore.setState({ tabsByWorktree: { [WORKTREE]: bound } })
    const next = controllerFor(bound, {
      backgroundMountTabIdsByWorktreeRef: controller.backgroundMountTabIdsByWorktreeRef,
      activationDeferredMountTabIdsByWorktreeRef:
        controller.activationDeferredMountTabIdsByWorktreeRef,
      lastActivationWorktreeIdRef: controller.lastActivationWorktreeIdRef,
      mountedWorktreeIdsRef: controller.mountedWorktreeIdsRef
    })
    applyTerminalColdActivation(next)

    expect(mountableTabIds(next)).toEqual(['tab-0', 'tab-3'])
  })

  it('leaves worktrees without unbound saved tabs fully mounted', () => {
    const tabs = [tab('a'), tab('b'), tab('c', { ptyId: 'pty-c', launchAgent: 'claude' })]
    useAppStore.setState({ tabsByWorktree: { [WORKTREE]: tabs } })
    const controller = controllerFor(tabs)

    applyTerminalColdActivation(controller)

    expect(controller.backgroundMountTabIdsByWorktreeRef.current.has(WORKTREE)).toBe(false)
    expect(mountableTabIds(controller)).toEqual(['a', 'b', 'c'])
  })
})

describe('isUnboundRestoredTerminalTab', () => {
  const empty = { ptyIdsByTabId: {}, terminalLayoutsByTabId: {}, pendingStartupByTabId: {} }

  it('holds saved shells and agent tabs that have no PTY anywhere', () => {
    expect(isUnboundRestoredTerminalTab(tab('a', { restoredFromSession: true }), empty)).toBe(true)
    expect(isUnboundRestoredTerminalTab(tab('b', { launchAgent: 'codex' }), empty)).toBe(true)
  })

  it('never holds a tab that is new this session, starting, or bound to a PTY', () => {
    expect(isUnboundRestoredTerminalTab(tab('fresh'), empty)).toBe(false)
    expect(
      isUnboundRestoredTerminalTab(tab('queued', { launchAgent: 'claude' }), {
        ...empty,
        pendingStartupByTabId: { queued: { command: 'claude' } }
      })
    ).toBe(false)
    expect(
      isUnboundRestoredTerminalTab(
        tab('launch', { launchAgent: 'claude', agentLaunchPane: { leafId: 'leaf' } }),
        empty
      )
    ).toBe(false)
    expect(
      isUnboundRestoredTerminalTab(tab('live', { restoredFromSession: true }), {
        ...empty,
        ptyIdsByTabId: { live: ['pty-1'] }
      })
    ).toBe(false)
    expect(
      isUnboundRestoredTerminalTab(tab('saved-leaf', { restoredFromSession: true }), {
        ...empty,
        terminalLayoutsByTabId: {
          'saved-leaf': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            ptyIdsByLeafId: { l: 'pty-9' }
          }
        }
      })
    ).toBe(false)
  })
})
