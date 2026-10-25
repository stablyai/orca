import type { Terminal } from '@xterm/xterm'
import { copyTerminalSelection } from '@/components/terminal-pane/terminal-selection-copy'
import type { PreviewTerminalPasteSource } from './preview-terminal-paste'
import {
  claimTerminalRightClickPasteMouseDown,
  isTerminalRightClickPasteGesture
} from '@/components/terminal-pane/terminal-right-click-paste-gesture'

type PreviewRightClickTerminal = Pick<Terminal, 'getSelection' | 'clearSelection' | 'focus'>

/**
 * Terminal-style right-click for the preview terminal, mirroring the pane's
 * useTerminalContextMenuTrigger: a selection copies and clears, no selection
 * pastes, and Ctrl+right-click keeps the native menu reachable.
 */
export function installPreviewTerminalRightClickPaste({
  container,
  getTerminal,
  isRightClickToPasteEnabled,
  pasteClipboardText
}: {
  container: HTMLElement
  getTerminal: () => PreviewRightClickTerminal | null
  isRightClickToPasteEnabled: () => boolean
  pasteClipboardText: (
    activeElementAtDispatch: Element | null,
    source: PreviewTerminalPasteSource
  ) => void
}): () => void {
  const onContextMenu = (event: MouseEvent): void => {
    const terminal = getTerminal()
    if (!terminal || !isRightClickToPasteEnabled() || event.ctrlKey) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (terminal.getSelection()) {
      void copyTerminalSelection({
        terminal,
        writeClipboardText: window.api.ui.writeTerminalClipboardText,
        clearSelectionOnSuccess: true
      }).catch(() => undefined)
      return
    }
    pasteClipboardText(document.activeElement, 'right-click')
  }
  const onMouseDown = (event: MouseEvent): void => {
    const terminal = getTerminal()
    if (terminal && isTerminalRightClickPasteGesture(event, isRightClickToPasteEnabled())) {
      claimTerminalRightClickPasteMouseDown(event, terminal)
    }
  }
  container.addEventListener('mousedown', onMouseDown, true)
  container.addEventListener('contextmenu', onContextMenu)
  return () => {
    container.removeEventListener('mousedown', onMouseDown, true)
    container.removeEventListener('contextmenu', onContextMenu)
  }
}
