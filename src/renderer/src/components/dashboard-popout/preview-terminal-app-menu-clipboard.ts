import type { Terminal } from '@xterm/xterm'
import { isEditableTarget } from '@/lib/editable-target'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import {
  APP_MENU_SELECTION_ACTION_EVENT,
  type AppMenuSelectionAction
} from '@/lib/app-menu-selection-actions'
import { copyTerminalSelection } from '@/components/terminal-pane/terminal-selection-copy'
import type { PreviewTerminalPasteSource } from './preview-terminal-paste'

type PreviewTerminalSelection = Pick<Terminal, 'getSelection' | 'selectAll' | 'clearSelection'>

/**
 * Routes Edit-menu and context-menu clipboard commands to the preview terminal.
 *
 * Listens to the renderer-wide ownership events, exactly like a real pane, and
 * NOT to the raw ui:appMenuPaste / ui:appMenuSelectionAction IPC. The
 * preventDefault() claim is load-bearing: without it the App-level handler
 * falls back to the focused text control, which for a focused terminal is
 * xterm's hidden .xterm-helper-textarea — the clipboard text lands there and
 * never reaches the PTY. Leaving an event unclaimed is equally deliberate: the
 * App handler then performs the native action for text controls.
 */
export function installPreviewTerminalAppMenuClipboard({
  container,
  getTerminal,
  pasteClipboardText
}: {
  container: HTMLElement
  getTerminal: () => PreviewTerminalSelection | null
  pasteClipboardText: (
    activeElementAtDispatch: Element | null,
    source: PreviewTerminalPasteSource
  ) => void
}): () => void {
  const onAppMenuPaste = (event: Event): void => {
    const active = document.activeElement
    if (!active || !container.contains(active)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    pasteClipboardText(active, 'app-menu')
  }
  const onAppMenuSelectionAction = (event: Event): void => {
    const active = document.activeElement
    const terminal = getTerminal()
    if (!active || !container.contains(active) || isEditableTarget(active) || !terminal) {
      return
    }
    const action = (event as CustomEvent<AppMenuSelectionAction>).detail
    if (action === 'select-all') {
      event.preventDefault()
      terminal.selectAll()
      return
    }
    if (!terminal.getSelection()) {
      return
    }
    event.preventDefault()
    void copyTerminalSelection({
      terminal,
      writeClipboardText: window.api.ui.writeTerminalClipboardText
    }).catch(() => undefined)
  }
  window.addEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
  window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, onAppMenuSelectionAction)
  return () => {
    window.removeEventListener(APP_MENU_PASTE_EVENT, onAppMenuPaste)
    window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, onAppMenuSelectionAction)
  }
}
