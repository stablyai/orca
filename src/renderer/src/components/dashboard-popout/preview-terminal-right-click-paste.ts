import type { Terminal } from '@xterm/xterm'
import { copyTerminalSelection } from '@/components/terminal-pane/terminal-selection-copy'
import { terminalForcesSelectionForClick } from '@/components/terminal-pane/terminal-click-forces-selection'
import type { PreviewTerminalPasteSource } from './preview-terminal-paste'

type PreviewRightClickTerminal = Pick<Terminal, 'getSelection' | 'clearSelection'> & {
  modes: Pick<Terminal['modes'], 'mouseTrackingMode'>
}

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
    // Why: a mouse-tracking TUI already got this press as a mouse report and may paste itself.
    if (terminal.modes.mouseTrackingMode !== 'none' && !terminalForcesSelectionForClick(event)) {
      return
    }
    pasteClipboardText(document.activeElement, 'right-click')
  }
  container.addEventListener('contextmenu', onContextMenu)
  return () => container.removeEventListener('contextmenu', onContextMenu)
}
