import type { AppState } from '@/store/types'
import { selectFloatingWorkspacePanelVisible } from '@/store/workspaces/floating/floating-workspace-panel-selector'
import { toast } from 'sonner'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from './floating-terminal'
import { floatingWorkspaceUnavailableReason } from './floating-workspace-availability'

function toggleFloatingWorkspacePanel(): void {
  window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
}

// Enable before toggling: floating tabs outlive feature disable and would otherwise reveal silently into nothing.
// Why enable first: floating tabs outlive a feature disable, and the panel ignores the toggle
// while disabled, so a live floating agent row would otherwise be a silent no-op.
/** Returns false when the floating workspace cannot be shown here (the user is told why). */
export function revealFloatingWorkspacePanel(
  state: Pick<AppState, 'settings' | 'updateSettings' | 'floatingWorkspacePanelOpen'>
): boolean {
  // Why: host reveals can beat settings hydration; enabling then would overwrite a saved `false`.
  if (!state.settings) {
    return true
  }
  const unavailable = floatingWorkspaceUnavailableReason()
  if (unavailable) {
    toast.info(unavailable)
    return false
  }
  if (state.settings.floatingTerminalEnabled === true) {
    if (!selectFloatingWorkspacePanelVisible(state)) {
      toggleFloatingWorkspacePanel()
    }
    return true
  }
  // Enabling shows a panel that was left open; only a closed one still needs the toggle.
  const wasOpen = state.floatingWorkspacePanelOpen
  void state.updateSettings({ floatingTerminalEnabled: true }).then(() => {
    if (!wasOpen) {
      // Why deferred a frame: the panel only honors the toggle once the enabled flag has reached React.
      requestAnimationFrame(toggleFloatingWorkspacePanel)
    }
  })
  return true
}
