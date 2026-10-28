import { useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { hasRegisteredRuntimeTerminalTab } from '../../runtime/mounted-terminal-tab-registry'
import { canWatcherCoverParkedTerminalTab } from '../terminal-pane/terminal-parked-tab-watchers'
import { canAdmitTerminalTabsForStartup } from './background-terminal-worktree-mount'
import {
  type TerminalPrewarmStage,
  getTerminalPrewarmWorktrees,
  setHeldTerminalPrewarmWorktrees,
  planTerminalPrewarmTabMount,
  subscribeTerminalPrewarmWorktrees,
  undoTerminalPrewarmNarrowing,
  areTabSessionsConfirmed,
  createDeferredNarrowingUndo,
  type TerminalPrewarmNarrowing
} from './terminal-worktree-prewarm'
import { TERMINAL_TAB_COLD_PARK_DELAY_MS } from '../terminal-pane/terminal-hidden-view-parking'
import type { TerminalColdActivationController } from '../terminal-cold-activation'
import { hasRetainedWorkspaceTerminalFrames } from './terminal-worktree-retained-frames'
import {
  resolveReattachPtyIds,
  scheduleTerminalPrewarmStage,
  selectRevealTerminalTabIds,
  selectSleepingTabIds
} from './terminal-worktree-prewarm-targets'

// Lets the parking pass re-park siblings once the cool-down ends, before the narrowing lifts.
const NARROWING_UNDO_MARGIN_MS = 1000

type PrewarmLease = {
  cancelNextStage: (() => void) | null
  // Hovered leases stay laid out for the press; neighbor-only leases settle hidden once warm.
  hovered: boolean
  /** Set when the lease narrowed a live, unrestricted mount; release hands those panes back. */
  narrowedLiveMount: TerminalPrewarmNarrowing | null
}

/**
 * Hold prewarmed workspaces' revealable terminals mounted so a switch reveals them at hot cost.
 * Hover keeps its target laid out; a neighbor is mounted, laid out and warmed once, then hidden but kept unparked.
 */
export function useTerminalWorktreePrewarm(controller: TerminalColdActivationController): void {
  const controllerRef = useRef(controller)
  useLayoutEffect(() => {
    controllerRef.current = controller
  })

  useEffect(() => {
    const leases = new Map<string, PrewarmLease>()
    const narrowingUndo = createDeferredNarrowingUndo({
      // Outlast the tab cold-park cool-down that ending this lease's measurement starts.
      delayMs: TERMINAL_TAB_COLD_PARK_DELAY_MS + NARROWING_UNDO_MARGIN_MS,
      undo: (worktreeId, narrowing) => {
        const c = controllerRef.current
        undoTerminalPrewarmNarrowing({
          restrictions: c.backgroundMountTabIdsByWorktreeRef.current,
          deferredMountTabIdsByWorktree: c.activationDeferredMountTabIdsByWorktreeRef.current,
          worktreeId,
          narrowing,
          isActivated:
            c.renderedActiveWorktreeId === worktreeId ||
            c.lastActivationWorktreeIdRef.current === worktreeId
        })
        bumpRevision()
      },
      remainingHoldMs: (worktreeId) => {
        const c = controllerRef.current
        // Another mount's measurement ends with its own cool-down, during which tab parking is off.
        if (
          c.measurableBackgroundWorktreeIdsRef.current.has(worktreeId) ||
          c.measuringTerminalWorktreeIdsRef.current.has(worktreeId)
        ) {
          return TERMINAL_TAB_COLD_PARK_DELAY_MS + NARROWING_UNDO_MARGIN_MS
        }
        const cooldownUntilMs = c.terminalWorktreeParkCooldownUntilRef.current.get(worktreeId)
        return cooldownUntilMs === undefined
          ? null
          : cooldownUntilMs + NARROWING_UNDO_MARGIN_MS - Date.now()
      }
    })
    const bumpRevision = (): void =>
      controllerRef.current.setBackgroundMountRevision((revision) => revision + 1)

    const stopMeasuring = (worktreeId: string): void => {
      const c = controllerRef.current
      c.prewarmLeasesRef.current.delete(worktreeId)
      if (!c.measurableBackgroundWorktreeTimersRef.current.has(worktreeId)) {
        c.measurableBackgroundWorktreeIdsRef.current.delete(worktreeId)
        // Skip the post-measure cool-down: ordinary parking (or the neighbor exemption) decides from here.
        c.measuringTerminalWorktreeIdsRef.current.delete(worktreeId)
      }
      bumpRevision()
    }

    const advance = (
      worktreeId: string,
      lease: PrewarmLease,
      stage: TerminalPrewarmStage
    ): void => {
      controllerRef.current.prewarmLeasesRef.current.set(worktreeId, stage)
      bumpRevision()
      const next = stage === 'mount' ? 'layout' : stage === 'layout' ? 'warm' : null
      if (next === null && lease.hovered) {
        return
      }
      lease.cancelNextStage = scheduleTerminalPrewarmStage(() => {
        lease.cancelNextStage = null
        if (next) {
          advance(worktreeId, lease, next)
        } else {
          stopMeasuring(worktreeId)
        }
      })
    }

    const startMeasuring = (
      worktreeId: string,
      lease: PrewarmLease,
      stage: TerminalPrewarmStage
    ) => {
      lease.cancelNextStage?.()
      controllerRef.current.measurableBackgroundWorktreeIdsRef.current.add(worktreeId)
      advance(worktreeId, lease, stage)
    }

    const release = (worktreeId: string, lease: PrewarmLease): void => {
      lease.cancelNextStage?.()
      leases.delete(worktreeId)
      if (lease.narrowedLiveMount) {
        narrowingUndo.schedule(worktreeId, lease.narrowedLiveMount)
      }
      stopMeasuring(worktreeId)
    }

    // Liveness checks in flight; a newer request or a release for the worktree invalidates the older answer.
    const livenessChecks = new Map<string, symbol>()

    /** `confirmedTabIds` is undefined until the daemon has answered for the tabs this lease would reattach. */
    const lease = (
      worktreeId: string,
      hovered: boolean,
      confirmedPtyIdsByTabId?: ReadonlyMap<string, ReadonlySet<string>>
    ): void => {
      const c = controllerRef.current
      if (
        // Without hidden-view parking nothing unmounts a released lease, so prewarm would pin every target.
        !c.terminalParkingEnabled ||
        worktreeId === c.renderedActiveWorktreeId ||
        !c.workspaceSurfaceIdSet.has(worktreeId) ||
        // Until startup publishes PTY ownership, a hidden mount could duplicate shells.
        !canAdmitTerminalTabsForStartup(c)
      ) {
        return
      }
      narrowingUndo.flush(worktreeId)
      const state = useAppStore.getState()
      // Restricting the surface drops its emulator overlay and loses the simulator's local state.
      if (
        (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
          (tab) => tab.contentType === 'simulator'
        )
      ) {
        return
      }
      const mounted = c.mountedWorktreeIdsRef.current.has(worktreeId)
      const restrictions = c.backgroundMountTabIdsByWorktreeRef.current
      const parked = c.effectiveParkedTerminalWorktreeIds.has(worktreeId)
      // A retained surface can hold individually parked tabs; measuring bypasses tab parking, so admit only what the reveal needs.
      const hasNonLiveTab = (state.tabsByWorktree[worktreeId] ?? []).some(
        (tab) => !hasRegisteredRuntimeTerminalTab(tab.id, worktreeId)
      )
      const needsTabPlan = !mounted || restrictions.has(worktreeId) || parked || hasNonLiveTab
      // Narrowing a live unrestricted mount is temporary (undone on release).
      const narrowsLiveMount = mounted && !restrictions.has(worktreeId) && !parked && hasNonLiveTab
      let narrowedLiveMount: PrewarmLease['narrowedLiveMount'] = null
      if (needsTabPlan) {
        const sleepingTabIds = selectSleepingTabIds(state, worktreeId)
        const tabs = state.tabsByWorktree[worktreeId] ?? []
        const revealTabIds = selectRevealTerminalTabIds(state, worktreeId)
        const isTabLive = (tabId: string): boolean =>
          hasRegisteredRuntimeTerminalTab(tabId, worktreeId)
        const isTabRestorable = (tab: TerminalTab): boolean =>
          canWatcherCoverParkedTerminalTab(worktreeId, tab)
        if (confirmedPtyIdsByTabId === undefined) {
          const reattachTabs = tabs.filter(
            (tab) =>
              revealTabIds.has(tab.id) &&
              tab.ptyId !== null &&
              !isTabLive(tab.id) &&
              !sleepingTabIds.has(tab.id) &&
              isTabRestorable(tab)
          )
          if (reattachTabs.length > 0) {
            confirmSessionsThenLease(worktreeId, reattachTabs)
            return
          }
        }
        const plan = planTerminalPrewarmTabMount({
          tabs,
          revealTabIds,
          isTabLive,
          isTabRestorable,
          isTabSleeping: (tabId) => sleepingTabIds.has(tabId),
          isSessionConfirmedLive: (tab) =>
            areTabSessionsConfirmed(
              resolveReattachPtyIds(tab, state),
              confirmedPtyIdsByTabId?.get(tab.id)
            )
        })
        if (!plan) {
          return
        }
        restrictions.set(worktreeId, plan.allowedTabIds)
        const deferred = c.activationDeferredMountTabIdsByWorktreeRef.current
        if (narrowsLiveMount) {
          const alreadyDeferred = deferred.get(worktreeId)
          narrowedLiveMount = {
            allowedTabIds: plan.allowedTabIds,
            deferredTabIds: new Set(
              [...plan.deferredTabIds].filter((tabId) => !alreadyDeferred?.has(tabId))
            )
          }
        }
        const nextDeferred = new Set([...(deferred.get(worktreeId) ?? []), ...plan.deferredTabIds])
        for (const tabId of plan.allowedTabIds) {
          nextDeferred.delete(tabId)
        }
        if (nextDeferred.size > 0) {
          deferred.set(worktreeId, nextDeferred)
        } else {
          deferred.delete(worktreeId)
        }
        c.mountedWorktreeIdsRef.current.add(worktreeId)
      }
      const next: PrewarmLease = { cancelNextStage: null, hovered, narrowedLiveMount }
      leases.set(worktreeId, next)
      if (needsTabPlan) {
        startMeasuring(worktreeId, next, 'mount')
      } else if (hovered || !hasRetainedWorkspaceTerminalFrames(worktreeId)) {
        startMeasuring(worktreeId, next, 'layout')
      }
      // A neighbor already holding revealable frames only needs the parking exemption.
    }

    const confirmSessionsThenLease = (worktreeId: string, tabs: readonly TerminalTab[]): void => {
      const token = Symbol(worktreeId)
      livenessChecks.set(worktreeId, token)
      const state = useAppStore.getState()
      void Promise.all(
        tabs.map(async (tab) => {
          // Mounting reconnects every leaf, so each leaf's session must be live, not just the tab's.
          const ptyIds = resolveReattachPtyIds(tab, state)
          const answers = await Promise.all(
            ptyIds.map((ptyId) => window.api.pty.hasPty(ptyId).catch(() => null))
          )
          // Only an authoritative true counts: null (unknown, remote runtime) must not authorize a reattach.
          const confirmed = new Set(ptyIds.filter((_ptyId, index) => answers[index] === true))
          return [tab.id, confirmed] as const
        })
      ).then((confirmedByTab) => {
        if (livenessChecks.get(worktreeId) !== token) {
          return
        }
        livenessChecks.delete(worktreeId)
        const clients = getTerminalPrewarmWorktrees().get(worktreeId)
        if (!clients || leases.has(worktreeId)) {
          return
        }
        // The second pass re-resolves each tab's leaves; any change since the check fails confirmation.
        lease(worktreeId, clients.has('hover'), new Map(confirmedByTab))
        setHeldTerminalPrewarmWorktrees(leases.keys())
        controllerRef.current.setTerminalParkingRevision((revision) => revision + 1)
      })
    }

    const sync = (): void => {
      const wanted = getTerminalPrewarmWorktrees()
      for (const [worktreeId, existing] of Array.from(leases)) {
        if (!wanted.has(worktreeId)) {
          release(worktreeId, existing)
        }
      }
      for (const worktreeId of Array.from(livenessChecks.keys())) {
        if (!wanted.has(worktreeId)) {
          livenessChecks.delete(worktreeId)
        }
      }
      for (const [worktreeId, clients] of wanted) {
        const hovered = clients.has('hover')
        const existing = leases.get(worktreeId)
        if (!existing) {
          lease(worktreeId, hovered)
        } else if (hovered !== existing.hovered) {
          existing.hovered = hovered
          if (hovered) {
            startMeasuring(worktreeId, existing, 'layout')
          } else if (existing.cancelNextStage === null) {
            stopMeasuring(worktreeId)
          }
        }
      }
      // Read by the parking pass this sync's revision bump schedules.
      setHeldTerminalPrewarmWorktrees(leases.keys())
    }
    sync()
    const unsubscribe = subscribeTerminalPrewarmWorktrees(sync)
    return () => {
      unsubscribe()
      livenessChecks.clear()
      for (const [worktreeId, existing] of Array.from(leases)) {
        release(worktreeId, existing)
      }
      // After the releases above: they schedule undos against refs this unmount is discarding.
      narrowingUndo.cancelAll()
      setHeldTerminalPrewarmWorktrees([])
    }
  }, [])
}
