import type { AppState } from '@/store/types'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from './floating-terminal'
import { isFloatingWorkspacePanelVisible } from './floating-workspace-terminal-actions'

function toggleFloatingWorkspacePanelIfHidden(): void {
  if (!isFloatingWorkspacePanelVisible()) {
    window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
  }
}

// Why enable first: floating tabs outlive a feature disable, and the panel ignores the toggle
// while disabled, so a live floating agent row would otherwise be a silent no-op.
export function revealFloatingWorkspacePanel(
  state: Pick<AppState, 'settings' | 'updateSettings'>
): void {
  if (state.settings?.floatingTerminalEnabled === true) {
    toggleFloatingWorkspacePanelIfHidden()
    return
  }
  void state.updateSettings({ floatingTerminalEnabled: true }).then(() => {
    // Why deferred a frame: the panel only honors the toggle once the enabled flag has reached React.
    requestAnimationFrame(toggleFloatingWorkspacePanelIfHidden)
  })
}
