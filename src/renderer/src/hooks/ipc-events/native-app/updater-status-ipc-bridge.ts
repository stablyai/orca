import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import { useAppStore } from '../../../store/index'

/** Installs updater listeners in their historical snapshot-before-push order. */
export function registerUpdaterStatusIpcBridge(unsubs: (() => void)[]): void {
  // Current behavior intentionally permits the initial snapshot to overwrite an earlier push.
  window.api.updater.getStatus().then((status) => {
    useAppStore.getState().setUpdateStatus(status as UpdateStatus)
  })

  unsubs.push(
    window.api.updater.onStatus((raw) => {
      useAppStore.getState().setUpdateStatus(raw as UpdateStatus)
    })
  )
  unsubs.push(
    window.api.updater.onClearDismissal(() => {
      useAppStore.getState().clearDismissedUpdateVersion()
    })
  )
  unsubs.push(
    window.api.updater.onAutoRestartDue(() => {
      void window.api.updater.quitAndInstall({ unattended: true }).catch((error) => {
        console.error('[updater] Failed to restart for an update:', error)
        return window.api.updater.declineAutoRestart().catch((declineError) => {
          console.error('[updater] Failed to decline automatic restart:', declineError)
        })
      })
    })
  )
}
