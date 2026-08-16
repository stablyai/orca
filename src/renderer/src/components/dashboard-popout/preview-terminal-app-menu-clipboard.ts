import type { Terminal } from '@xterm/xterm'
import { isEditableTarget } from '@/lib/editable-target'

type PreviewTerminalSelection = Pick<Terminal, 'getSelection' | 'selectAll'>

export function installPreviewTerminalAppMenuClipboard({
  container,
  getTerminal,
  pasteClipboardText
}: {
  container: HTMLElement
  getTerminal: () => PreviewTerminalSelection | null
  pasteClipboardText: (activeElementAtDispatch: Element | null, source: 'app-menu') => Promise<void>
}): () => void {
  const offPaste = window.api.ui.onAppMenuPaste(() => {
    const active = document.activeElement
    if (active && container.contains(active)) {
      void pasteClipboardText(active, 'app-menu')
    }
  })
  const offSelection = window.api.ui.onAppMenuSelectionAction((action) => {
    const active = document.activeElement
    const terminal = getTerminal()
    if (!active || !container.contains(active) || isEditableTarget(active) || !terminal) {
      window.api.ui.performNativeSelectionAction(action)
      return
    }
    if (action === 'select-all') {
      terminal.selectAll()
      return
    }
    const selection = terminal.getSelection()
    if (selection) {
      void window.api.ui.writeTerminalClipboardText(selection).catch(() => undefined)
    } else {
      window.api.ui.performNativeSelectionAction(action)
    }
  })
  return () => {
    offPaste()
    offSelection()
  }
}
