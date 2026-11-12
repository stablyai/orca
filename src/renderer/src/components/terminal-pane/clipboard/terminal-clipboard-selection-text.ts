import type { Terminal } from '@xterm/xterm'
import { useAppStore } from '@/store/index'
import { stripTerminalSelectionGutter } from '../../../../../shared/terminal/output/terminal-selection-gutter'

/** Missing legacy settings retain the default trimming behavior. */
export function terminalCopyTrimsGutter(): boolean {
  return useAppStore.getState().settings?.terminalCopyTrimsGutter !== false
}

/**
 * The selection text every terminal clipboard path should write: screen cells
 * minus the left gutter the agent CLI painted them behind (#19770).
 */
export function readTerminalClipboardSelection(terminal: Pick<Terminal, 'getSelection'>): string {
  const selection = terminal.getSelection()
  if (!terminalCopyTrimsGutter()) {
    return selection
  }
  return stripTerminalSelectionGutter(selection)
}
