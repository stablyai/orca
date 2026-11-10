// Wires predictive wake to the app: the setting, the cloud status cache, the window's focus, and
// the ordinary wake IPC (main's wake is single-flight per workspace, so a later open joins it).
import { useAppStore } from '@/store'
import {
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
        await window.api.ephemeralVm.resumeWorkspace({ workspaceId }).catch(() => null)
        await refreshCloudWorkspaceStatus(workspaceId)
      },
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
    })
  )
  const onFocus = (): void =>
    notePredictiveWakeWindowFocus(useAppStore.getState().activeWorktreeId ?? null)
  const onBlur = (): void => notePredictiveWakeWindowBlur()
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  return () => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('blur', onBlur)
    setPredictiveWakeController(null)
  }
}
