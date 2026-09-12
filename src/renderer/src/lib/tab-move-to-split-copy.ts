import { TAB_MOVE_TO_SPLIT_COMMANDS, type KeybindingActionId } from '../../../shared/keybindings'
import type { TabSplitDirection } from '../store/slices/tabs'
import { translate } from '@/i18n/i18n'

const DIRECTION_BY_ACTION: ReadonlyMap<KeybindingActionId, TabSplitDirection> = new Map(
  TAB_MOVE_TO_SPLIT_COMMANDS.map(({ id, direction }) => [id, direction] as const)
)

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

export function translateShortcutDefinitionTitle(
  actionId: KeybindingActionId,
  fallback: string
): string {
  const direction = DIRECTION_BY_ACTION.get(actionId)
  if (!direction) {
    return fallback
  }
  return translate('auto.lib.tabMoveToSplitCopy.shortcutTitle', '{{value0}}: {{value1}}', {
    value0: translateTabMoveToSplitLabel(),
    value1: translateTabMoveToSplitDirection(direction)
  })
}
