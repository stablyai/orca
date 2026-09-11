import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import {
  isActivationAdmissionEligible,
  pickNextActivationDeferredTabId,
  scheduleActivationDeferredAdmission
} from './activation-deferred-tab-admission'
import { revealActivationDeferredTabs } from './background-terminal-worktree-mount'
import type { TerminalColdActivationController } from '../terminal-cold-activation'

/**
 * Mounts the active worktree's activation-deferred tabs, one per idle frame.
 *
 * Why after the reveal and not during it: the switch only owes the user the
 * pane they are looking at. Everything else is warm-up, so it runs where it
 * cannot delay a frame — and the worktree still ends up as fully mounted as it
 * was before deferral, which is what keeps later tab switches instant.
 *
 * One tab per effect run, not a loop: admitting bumps the mount revision, which
 * re-runs this effect and schedules the next one. The drain is the render cycle.
 */
export function useActivationDeferredTabAdmission(
  controller: TerminalColdActivationController
): void {
  const {
    activationDeferredMountTabIdsByWorktreeRef,
    backgroundMountRevision,
    backgroundMountTabIdsByWorktreeRef,
    renderedActiveWorktreeId,
    setBackgroundMountRevision
  } = controller
  // Why the verdict is taken once per activation: draining the set must not walk
  // an over-cap worktree down into eligibility and warm up tabs the pre-deferral
  // behaviour would have left unmounted.
  const admissionRef = useRef<{ worktreeId: string; eligible: boolean } | null>(null)

  useEffect(() => {
    const worktreeId = renderedActiveWorktreeId
    if (!worktreeId) {
      return
    }
    const deferredTabIds = activationDeferredMountTabIdsByWorktreeRef.current.get(worktreeId)
    if (admissionRef.current?.worktreeId !== worktreeId) {
      admissionRef.current = {
        worktreeId,
        eligible: isActivationAdmissionEligible(deferredTabIds?.size ?? 0)
      }
    }
    if (!admissionRef.current.eligible || !deferredTabIds?.size) {
      return
    }
    return scheduleActivationDeferredAdmission(() => {
      // Why re-read: tabs can be created or closed between the scheduling frame
      // and this one, and admitting a stale id would strand the restriction.
      const allTabIds = (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).map(
        (tab) => tab.id
      )
      const nextTabId = pickNextActivationDeferredTabId(
        allTabIds,
        activationDeferredMountTabIdsByWorktreeRef.current.get(worktreeId)
      )
      if (!nextTabId) {
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- controller refs and setters preserve their original stable identities.
  }, [backgroundMountRevision, renderedActiveWorktreeId])
}
