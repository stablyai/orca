// Wires predictive wake to the app: the setting, the cloud status cache, the window's focus, and
// the ordinary wake IPC (main's wake is single-flight per workspace, so a later open joins it).
import { useAppStore } from '@/store'
import {
  getLastBillingStatus,
  refreshBillingSummary
} from '@/components/billing/billing-summary-store'
import { sandboxLimitFromBilling } from '@/components/worktree-creation/vm-build-sandbox-limit'
import { predictiveWakeServerVerdict } from './cloud-predictive-wake-preflight'
import {
  claimPredictiveWake,
  isPredictiveWakeOutstanding,
  createPredictiveWakeController,
  notePredictiveWakeWindowBlur,
  notePredictiveWakeWindowFocus,
  setPredictiveWakeController
} from './cloud-predictive-wake'
import {
  getCloudWorkspaceSnapshot,
  isCloudWorkspaceArchived,
  refreshCloudWorkspaceStatus
} from './orca-cloud-workspace-store'
import { isWorktreeSleepViewHeld } from '@/lib/worktree-sleep-view'
import { isPairedCloudWorkspace, wakePairedCloudWorkspace } from './paired-cloud-wake'

/** A fresh status (cheap while asleep: no VM probe) and billing's caps, read just before waking. */
async function serverAllowsPredictiveWake(workspaceId: string): Promise<boolean> {
  await Promise.all([
    refreshCloudWorkspaceStatus(workspaceId),
    getLastBillingStatus() ? null : refreshBillingSummary()
  ])
  const entry = getCloudWorkspaceSnapshot().status[workspaceId]
  // A failed read keeps the previous status; a guess is not worth acting on stale hints.
  const status = entry && !entry.error ? entry.status : null
  const limit = sandboxLimitFromBilling(getLastBillingStatus())
  return predictiveWakeServerVerdict(status, limit) === 'ok'
}

/** Asleep, not archived, not already waking, not held read-only: owned and PAIRED alike. */
export function isPredictiveWakeCandidate(workspaceId: string): boolean {
  const snapshot = getCloudWorkspaceSnapshot()
  // People can't tell an owned workspace from a paired one; both wake on intent, same caps.
  return (
    (snapshot.ids.has(workspaceId) || isPairedCloudWorkspace(workspaceId)) &&
    snapshot.status[workspaceId]?.status?.state === 'sleeping' &&
    !isCloudWorkspaceArchived(workspaceId) &&
    !snapshot.wake[workspaceId] &&
    // Kept on screen read-only after its Sleep: only an explicit Wake wakes it.
    !isWorktreeSleepViewHeld(workspaceId)
  )
}

function claimInMain(workspaceId: string): void {
  void window.api.ephemeralVm.resumeWorkspace({ workspaceId, claimOnly: true }).catch(() => null)
}

export function installCloudPredictiveWake(): () => void {
  if (typeof window === 'undefined' || !window.api?.ephemeralVm?.resumeWorkspace) {
    return () => {}
  }
  setPredictiveWakeController(
    createPredictiveWakeController({
      now: Date.now,
      isEnabled: () => useAppStore.getState().settings?.orcaCloudPredictiveWake !== false,
      isWakeCandidate: isPredictiveWakeCandidate,
      preflight: serverAllowsPredictiveWake,
      wake: async (workspaceId) => {
        if (isPairedCloudWorkspace(workspaceId)) {
          // No VM record here to resume: the control plane wakes it. Quiet, like the owned path.
          const woke = (await wakePairedCloudWorkspace(workspaceId, { quiet: true })).ok
          if (woke && useAppStore.getState().activeWorktreeId === workspaceId) {
            claimPredictiveWake(workspaceId)
          }
          return woke
        }
        // Quiet: a refusal leaves no failed-resume record behind (main), and no card (store).
        const result = await window.api.ephemeralVm
          .resumeWorkspace({ workspaceId, quiet: true })
          .catch(() => null)
        await refreshCloudWorkspaceStatus(workspaceId)
        if (result?.ok === true && result.resumed === false) {
          // Already up (main found nothing to resume): no wake happened, so nothing to hold.
          return 'skipped'
        }
        if (result?.ok === true && useAppStore.getState().activeWorktreeId === workspaceId) {
          // Woken for the workspace the user is already in (window focus, or hover then open):
          // it is open, not a guess, so it keeps the normal idle window.
          claimPredictiveWake(workspaceId)
          claimInMain(workspaceId)
        }
        return result?.ok === true
      },
      setTimer: (run, ms) => {
        const timer = setTimeout(run, ms)
        return () => clearTimeout(timer)
      }
    })
  )
  const onFocus = (): void =>
    notePredictiveWakeWindowFocus(useAppStore.getState().activeWorktreeId ?? null)
  const onBlur = (): void => notePredictiveWakeWindowBlur()
  // Any activation (agent row, notification, CLI, another panel) opens the workspace: claim its
  // intent wake so main returns it to the normal idle window.
  const unsubscribeActive = useAppStore.subscribe((state, previous) => {
    const active = state.activeWorktreeId
    if (!active || active === previous.activeWorktreeId) {
      return
    }
    const owned = getCloudWorkspaceSnapshot().ids.has(active)
    if (!owned && !isPairedCloudWorkspace(active)) {
      return
    }
    if (isPredictiveWakeOutstanding(active)) {
      claimPredictiveWake(active)
    }
    if (owned) {
      // Main may still hold it as woken-unopened (also after the window's own hold ran out).
      claimInMain(active)
    }
  })
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  return () => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('blur', onBlur)
    unsubscribeActive()
    setPredictiveWakeController(null)
  }
}
