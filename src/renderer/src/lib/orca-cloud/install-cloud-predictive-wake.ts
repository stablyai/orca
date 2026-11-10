// Wires predictive wake to the app: the setting, the cloud status cache, the window's focus, and
// the ordinary wake IPC (main's wake is single-flight per workspace, so a later open joins it).
import { useAppStore } from '@/store'
import { runSleepWorktree } from '@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow'
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
        // Quiet: a refusal leaves no failed-resume record behind (main), and no card (store).
        const result = await window.api.ephemeralVm
          .resumeWorkspace({ workspaceId, quiet: true })
          .catch(() => null)
        await refreshCloudWorkspaceStatus(workspaceId)
        return result?.ok === true
      },
      sleep: async (workspaceId) => {
        // Never put away the workspace the user is looking at.
        if (useAppStore.getState().activeWorktreeId === workspaceId) {
          return
        }
        await runSleepWorktree(workspaceId)
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
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  return () => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('blur', onBlur)
    setPredictiveWakeController(null)
  }
}
