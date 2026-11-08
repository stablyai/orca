import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

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

export function terminalPaneCloseLabel(paneCount: number, t: Translate = translate): string {
  return paneCount > 1
    ? t('auto.components.terminal.pane.TerminalContextMenu.8c17d6786d', 'Close Pane')
    : t('auto.components.tab.bar.SortableTab.95db5f2f7d', 'Close tab')
}
