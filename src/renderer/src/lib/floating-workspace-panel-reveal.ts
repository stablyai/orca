import type { AppState } from '@/store/types'
import { selectFloatingWorkspacePanelVisible } from '@/store/floating-workspace-panel-selector'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from './floating-terminal'

function toggleFloatingWorkspacePanel(): void {
  window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
}

/** Opens the floating panel unless it is already on screen. */
// Why enable first: floating tabs outlive a feature disable, and the panel ignores the toggle
// while disabled, so a live floating agent row would otherwise be a silent no-op.
export function revealFloatingWorkspacePanel(
  state: Pick<AppState, 'settings' | 'updateSettings' | 'floatingWorkspacePanelOpen'>
): void {
  if (state.settings?.floatingTerminalEnabled === true) {
    if (!selectFloatingWorkspacePanelVisible(state)) {
      toggleFloatingWorkspacePanel()
    }
    return
  }
  // Enabling shows a panel that was left open; only a closed one still needs the toggle.
  const wasOpen = state.floatingWorkspacePanelOpen
  void state.updateSettings({ floatingTerminalEnabled: true }).then(() => {
    if (!wasOpen) {
      // Why deferred a frame: the panel only honors the toggle once the enabled flag has reached React.
      requestAnimationFrame(toggleFloatingWorkspacePanel)
    }
  })
}
