import { useAppStore } from '@/store'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Whether main starts this pane's terminal: a layout-owner build, and main owns the workspace. */
export function mainStartsPane(session: {
  deps: ConnectPanePtySession['deps']
  runtimeEnvironmentId?: string | null
  mainPaneStartHandedBack?: boolean
}): boolean {
  return (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    !session.runtimeEnvironmentId &&
    // Main handed a twin's start back: the window starts it as today from then on.
    !session.mainPaneStartHandedBack &&
    !runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), session.deps.worktreeId)
  )
}

/** A hidden pane's start through main waits for its first view, as a hidden agent resume does (#29459). */
export function startMainPaneOnFirstView(session: ConnectPanePtySession, start: () => void): void {
  session.mainPaneStartOnReveal = () => {
    session.mainPaneStartOnReveal = null
    start()
  }
}
