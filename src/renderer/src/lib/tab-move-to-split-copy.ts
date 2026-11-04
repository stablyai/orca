import type { TabSplitDirection } from '../store/slices/tabs'
import { translate } from '@/i18n/i18n'

export function translateTabMoveToSplitLabel(): string {
  return translate(
    'auto.components.tab.bar.TabWorkspaceLayoutMenuSection.moveToPaneColumn',
    'Move Tab to Split'
  )
}

export function translateTabMoveToSplitDirection(direction: TabSplitDirection): string {
  switch (direction) {
    case 'right':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.right', 'Right')
    case 'left':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.left', 'Left')
    case 'down':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.down', 'Down')
    case 'up':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.up', 'Up')
  }
}

// Why: composed from the menu's translated copy so shortcut titles are localized wherever the menu is.
export function translateTabMoveToSplitTitle(direction: TabSplitDirection): string {
  return translate('auto.lib.tabMoveToSplitCopy.shortcutTitle', '{{label}}: {{direction}}', {
    label: translateTabMoveToSplitLabel(),
    direction: translateTabMoveToSplitDirection(direction)
  })
}
