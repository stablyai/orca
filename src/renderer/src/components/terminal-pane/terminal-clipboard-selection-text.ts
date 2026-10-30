import type { Terminal } from '@xterm/xterm'
import { useAppStore } from '@/store'
import { stripTerminalSelectionGutter } from '../../../../shared/terminal-selection-gutter'

/**
 * The selection text every terminal clipboard path should write: screen cells
 * minus the left gutter the agent CLI painted them behind (#19770).
 */
export function readTerminalClipboardSelection(terminal: Pick<Terminal, 'getSelection'>): string {
  const selection = terminal.getSelection()
  // Missing legacy settings retain the default trimming behavior.
  if (useAppStore.getState().settings?.terminalCopyTrimsGutter === false) {
    return selection
  }
  return stripTerminalSelectionGutter(selection)
}
