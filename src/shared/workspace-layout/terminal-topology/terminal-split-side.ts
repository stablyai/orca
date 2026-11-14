import type { TerminalPaneSplitDirection } from '../terminal-tab-types'

export function terminalSplitSide(
  direction: TerminalPaneSplitDirection,
  insertBefore = false
): 'left' | 'right' | 'top' | 'bottom' {
  return direction === 'vertical'
    ? insertBefore
      ? 'left'
      : 'right'
    : insertBefore
      ? 'top'
      : 'bottom'
}
