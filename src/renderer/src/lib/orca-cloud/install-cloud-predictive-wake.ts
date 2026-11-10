// Wires predictive wake to the app: the setting, the cloud status cache, the window's focus, and
// the ordinary wake IPC (main's wake is single-flight per workspace, so a later open joins it).
import { useAppStore } from '@/store'
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

export function installCloudPredictiveWake(): () => void {
  if (typeof window === 'undefined' || !window.api?.ephemeralVm?.resumeWorkspace) {
    return () => {}
  }
  setPredictiveWakeController(
    createPredictiveWakeController({
      now: Date.now,
      isEnabled: () => useAppStore.getState().settings?.orcaCloudPredictiveWake !== false,
      isWakeCandidate: (workspaceId) => {
        const snapshot = getCloudWorkspaceSnapshot()
        return (
          snapshot.ids.has(workspaceId) &&
          snapshot.status[workspaceId]?.status?.state === 'sleeping' &&
          !isCloudWorkspaceArchived(workspaceId) &&
          !snapshot.wake[workspaceId]
        )
      },
      wake: async (workspaceId) => {
        // Quiet: a refusal leaves no failed-resume record behind (main), and no card (store).
        const result = await window.api.ephemeralVm
          .resumeWorkspace({ workspaceId, quiet: true })
          .catch(() => null)
        await refreshCloudWorkspaceStatus(workspaceId)
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
    if (active && active !== previous.activeWorktreeId && isPredictiveWakeOutstanding(active)) {
      claimPredictiveWake(active)
      // Main's claim: the VM is up (or waking), so this joins that wake and wakes nothing new.
      void window.api.ephemeralVm.resumeWorkspace({ workspaceId: active }).catch(() => null)
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
