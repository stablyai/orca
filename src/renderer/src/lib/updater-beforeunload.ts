import {
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../../../shared/updater-renderer-events'

let updaterQuitAndInstallInProgress = false

export function isUpdaterQuitAndInstallInProgress(): boolean {
  return updaterQuitAndInstallInProgress
}

export function registerUpdaterBeforeUnloadBypass(): () => void {
  const markInProgress = (): void => {
    updaterQuitAndInstallInProgress = true
  }
  const clearInProgress = (): void => {
    updaterQuitAndInstallInProgress = false
  }

  window.addEventListener(ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT, markInProgress)
  window.addEventListener(ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT, clearInProgress)

  return () => {
    window.removeEventListener(ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT, markInProgress)
    window.removeEventListener(ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT, clearInProgress)
    // Why: hot reloads can re-register this listener inside the same renderer.
    // Reset the module flag on cleanup so a failed earlier install attempt
    // cannot silently suppress future unsaved-change prompts.
    updaterQuitAndInstallInProgress = false
  }
}
