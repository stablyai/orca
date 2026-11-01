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

/** Claim renderer ownership events to paste into the PTY; unclaimed events fall back to native controls, including xterm’s hidden textarea. */
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
