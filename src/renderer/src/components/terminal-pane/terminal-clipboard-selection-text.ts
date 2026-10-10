import type { Terminal } from '@xterm/xterm'
import { useAppStore } from '@/store'
import { cleanTerminalSelection } from '../../../../shared/terminal-selection-gutter'
import { terminalShowsAgentOutput } from './terminal-agent-output-probe'

type SelectionTerminal = Pick<Terminal, 'getSelection'> &
  Partial<Pick<Terminal, 'getSelectionPosition' | 'cols'>>

/**
 * The selection text every terminal clipboard path should write: screen cells
 * minus the left gutter the agent CLI painted them behind (#19770), with rows
 * the agent hard-wrapped joined back into paragraphs when the pane runs an agent.
 */
export function readTerminalClipboardSelection(terminal: SelectionTerminal): string {
  const selection = terminal.getSelection()
  // Why `=== false`: profiles saved before the setting existed have no key, and
  // they should trim like every new profile does.
  if (useAppStore.getState().settings?.terminalCopyTrimsGutter === false) {
    return selection
  }
  const range = terminal.getSelectionPosition?.()
  if (!range || !terminal.cols) {
    return cleanTerminalSelection(selection)
  }
  // Why: a selection dragged upwards reports start after end.
  const startFirst =
    range.start.y < range.end.y || (range.start.y === range.end.y && range.start.x <= range.end.x)
  const start = startFirst ? range.start : range.end
  return cleanTerminalSelection(selection, {
    startCol: start.x,
    cols: terminal.cols,
    joinWrappedRows: terminalShowsAgentOutput(terminal)
  })
}
