import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { FloatingWorkspaceMode } from '../../../../shared/ui-chrome-types'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'

/** A browser tab cannot open a second Orca window, so a web client only has the in-window panel. */
export function canOpenFloatingWorkspacePopout(): boolean {
  return !isPairedWebClientWindow()
}

export function resolveFloatingWorkspaceMode(
  settings:
    | Pick<
        GlobalSettings,
        | 'floatingTerminalEnabled'
        | 'experimentalFloatingWorkspacePopout'
        | 'experimentalFloatingWorkspaceMode'
      >
    | null
    | undefined
): FloatingWorkspaceMode {
  return canOpenFloatingWorkspacePopout() &&
    settings?.floatingTerminalEnabled === true &&
    settings.experimentalFloatingWorkspacePopout === true &&
    settings.experimentalFloatingWorkspaceMode === 'popout'
    ? 'popout'
    : 'in-window'
}
