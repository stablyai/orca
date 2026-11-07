import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { APP_MENU_SELECTION_ACTION_EVENT } from '@/lib/app-menu-selection-actions'
import { consumeCopyModeEvent } from './terminal-copy-mode-key-guard'
import type { TerminalCopyModeView } from './terminal-copy-mode-view'

export function installCopyModeMenuGuard(getOwnedView: () => TerminalCopyModeView | null) {
  const onPaste = (event: Event): void => {
    if (!event.defaultPrevented && getOwnedView()) {
      consumeCopyModeEvent(event)
    }
  }
  const onSelectionAction = (event: Event): void => {
    if (event.defaultPrevented || !(event instanceof CustomEvent)) {
      return
    }
    const action: unknown = event.detail
    if (action !== 'copy' && action !== 'select-all') {
      return
    }
    const view = getOwnedView()
    if (view) {
      consumeCopyModeEvent(event)
      view.handleMenuSelectionAction(action)
    }
  }
  // Menu events target window, so claim them before the live pane's bubble listeners.
  window.addEventListener(APP_MENU_PASTE_EVENT, onPaste, true)
  window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, onSelectionAction, true)
  return () => {
    window.removeEventListener(APP_MENU_PASTE_EVENT, onPaste, true)
    window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, onSelectionAction, true)
  }
}
