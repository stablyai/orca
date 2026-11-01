import { translate } from '@/i18n/i18n'

// Pinned tabs and one-off command terminals (no split button) offer no single-pane close.
export function canCloseTerminalPane({
  paneCount,
  showSplitButton,
  isTabPinned
}: {
  paneCount: number
  showSplitButton: boolean
  isTabPinned: boolean
}): boolean {
  return paneCount > 1 || (showSplitButton && !isTabPinned)
}

export function terminalPaneCloseLabel(paneCount: number): string {
  return paneCount > 1
    ? translate('auto.components.terminal.pane.TerminalContextMenu.8c17d6786d', 'Close Pane')
    : translate('auto.components.tab.bar.SortableTab.95db5f2f7d', 'Close tab')
}
