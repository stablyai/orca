import { translate } from '@/i18n/i18n'
import { getShortcutPlatform } from '@/lib/shortcut-platform'

/** The modifier-click chord as the UI names it: ⌘-click on macOS, Ctrl+click elsewhere. */
export function platformModifierClickLabel(): string {
  return getShortcutPlatform() === 'darwin' ? '⌘-click' : 'Ctrl+click'
}

export function isPlatformModifierClick(
  event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey'>
): boolean {
  return getShortcutPlatform() === 'darwin' ? event.metaKey : event.ctrlKey
}

/** Which card action a click asks for: the setting picks the plain-click
 *  default and the platform modifier flips to the other one. */
export function agentCardClickOpensWorktree(
  event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey'>,
  clickOpensWorktree: boolean
): boolean {
  return clickOpensWorktree !== isPlatformModifierClick(event)
}

/** Hover hint naming both actions in their current assignment. */
export function agentCardActivationHint(clickOpensWorktree: boolean): string {
  const modifierClick = platformModifierClickLabel()
  return clickOpensWorktree
    ? translate(
        'dashboardPopout.card.clickHint.openWorktree',
        'Click to open the worktree · {{modifierClick}} for a live preview',
        { modifierClick }
      )
    : translate(
        'dashboardPopout.card.clickHint.preview',
        'Click for a live preview · {{modifierClick}} to open the worktree',
        { modifierClick }
      )
}
