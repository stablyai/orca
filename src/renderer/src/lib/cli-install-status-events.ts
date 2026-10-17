export const CLI_INSTALL_STATUS_CHANGED_EVENT = 'orca:cli-install-status-changed'

/**
 * Settings → CLI owns PATH registration, but the setup checklist and any other live
 * reader hold their own probe. Announce the change so they can re-read instead of
 * waiting for a window focus or visibility change.
 */
export function notifyCliInstallStatusChanged(): void {
  window.dispatchEvent(new CustomEvent(CLI_INSTALL_STATUS_CHANGED_EVENT))
}
