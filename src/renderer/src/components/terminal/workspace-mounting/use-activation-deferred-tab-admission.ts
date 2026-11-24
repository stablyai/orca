import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import {
  isActivationAdmissionEligible,
  markActivationAdmissionDrained,
  pickNextActivationDeferredTabId,
  scheduleActivationDeferredAdmission
} from './activation-deferred-tab-admission'
import { revealActivationDeferredTabs } from './background-terminal-worktree-mount'
import type { TerminalColdActivationController } from './terminal-cold-activation'
import { isUnboundRestoredTerminalTab } from './unbound-restored-terminal-tab'

/** Warm one deferred tab per idle effect pass after reveal; mount revision schedules the next pass without blocking the switch frame. */
export function useActivationDeferredTabAdmission(
  controller: TerminalColdActivationController
): void {
  const {
    activationDeferralPlanRevision,
    activationDeferredMountTabIdsByWorktreeRef,
    backgroundMountRevision,
    backgroundMountTabIdsByWorktreeRef,
    renderedActiveWorktreeId,
    setBackgroundMountRevision
  } = controller
  // Track peak deferral size so draining cannot make over-cap plans eligible; recheck growth because startup hydration initially exposes an empty plan.
  const admissionRef = useRef<{ worktreeId: string; maxDeferredTabCount: number } | null>(null)

  useEffect(() => {
    const worktreeId = renderedActiveWorktreeId
    if (!worktreeId) {
      return
    }
    const deferredTabCount =
      activationDeferredMountTabIdsByWorktreeRef.current.get(worktreeId)?.size ?? 0
    if (deferredTabCount === 0) {
      return
    }
    const previous = admissionRef.current
    const maxDeferredTabCount =
      previous?.worktreeId === worktreeId
        ? Math.max(previous.maxDeferredTabCount, deferredTabCount)
        : deferredTabCount
    admissionRef.current = { worktreeId, maxDeferredTabCount }
    if (!isActivationAdmissionEligible(maxDeferredTabCount)) {
      return
    }
    return scheduleActivationDeferredAdmission(() => {
      // Tabs can change between scheduling and admission; stale IDs would strand the restriction.
      const state = useAppStore.getState()
      const tabs = state.tabsByWorktree[worktreeId] ?? []
      const allTabIds = tabs.map((tab) => tab.id)
      // Unbound saved tabs spawn nothing while hidden, so warming them only leaves an empty xterm that can never park; they mount when shown.
      const warmableTabIds = tabs
        .filter((tab) => !isUnboundRestoredTerminalTab(tab, state))
        .map((tab) => tab.id)
      const nextTabId = pickNextActivationDeferredTabId(
        warmableTabIds,
        activationDeferredMountTabIdsByWorktreeRef.current.get(worktreeId)
      )
      if (!nextTabId) {
        const restriction = backgroundMountTabIdsByWorktreeRef.current.get(worktreeId)
        // Only unbound tabs remain; base drained here, so the hidden overlays it gated mount again.
        if (restriction && markActivationAdmissionDrained(restriction)) {
          setBackgroundMountRevision((revision) => revision + 1)
        }
        return
      }
      revealActivationDeferredTabs({
        restrictions: backgroundMountTabIdsByWorktreeRef.current,
        deferredMountTabIdsByWorktree: activationDeferredMountTabIdsByWorktreeRef.current,
        worktreeId,
        allTabIds,
        immediateTabIds: new Set([nextTabId])
      })
      setBackgroundMountRevision((revision) => revision + 1)
    })
    // Opening the startup gate can install a refs-only plan for the active workspace; its revision must trigger mounting.
  }, [
    activationDeferralPlanRevision,
    activationDeferredMountTabIdsByWorktreeRef,
    backgroundMountRevision,
    backgroundMountTabIdsByWorktreeRef,
    renderedActiveWorktreeId,
    setBackgroundMountRevision
  ])
}
