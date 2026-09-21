import type { RateLimitState } from '../../../../shared/rate-limit-types'
import { useAppStore } from '../../store'

export function registerRateLimitIpcBridge(unsubs: (() => void)[]): void {
  let initialSnapshotPending = true
  let receivedPushBeforeInitialSnapshot = false
  unsubs.push(
    window.api.rateLimits.onUpdate((state) => {
      if (initialSnapshotPending) {
        receivedPushBeforeInitialSnapshot = true
      }
      useAppStore.getState().setRateLimitsFromPush(state as RateLimitState)
    })
  )
  // The startup get is a fallback: a push before resolution permanently wins.
  window.api.rateLimits.get().then((state) => {
    initialSnapshotPending = false
    if (receivedPushBeforeInitialSnapshot) {
      return
    }
    useAppStore.getState().setRateLimitsFromPush(state as RateLimitState)
  })

  const unsubscribeWorkspaceSpaceProgress = window.api.workspaceSpace?.onProgress?.((progress) => {
    useAppStore.getState().applyWorkspaceSpaceProgress(progress)
  })
  if (unsubscribeWorkspaceSpaceProgress) {
    unsubs.push(unsubscribeWorkspaceSpaceProgress)
  }
}
