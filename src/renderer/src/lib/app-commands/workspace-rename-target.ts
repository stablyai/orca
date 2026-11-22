import { translate } from '@/i18n/i18n'
import type { SidebarRevealTarget } from '../../../../shared/sidebar-list/sidebar-reveal-target'

/** Why Rename worktree can't act on what is in front, or null when it can. A bot's worker line is a
 *  worktree and renames in the Bots section; a bot's or group's page is its home, which isn't one. */
export function workspaceRenameUnsupportedReason(target: SidebarRevealTarget): string | null {
  if (target.section === 'bots' && !target.worker) {
    return translate(
      'sidebar.revealCurrent.renameBotPage',
      'A bot’s or group’s page isn’t a worktree. To rename it, use Rename in its row’s menu.'
    )
  }
  if (
    target.section === 'none' &&
    (target.reason === 'bots-off' || target.reason === 'bot-hidden')
  ) {
    return translate(
      'sidebar.revealCurrent.renameUnlisted',
      'This workspace isn’t listed in the sidebar right now, so it can’t be renamed there.'
    )
  }
  return null
}
