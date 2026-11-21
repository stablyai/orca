import type { Translate } from '@/i18n/use-translate'

/** One agent's menu wording, shared by Activity rows and sidebar agent rows so the two can't drift. */
export function agentMenuLabels(t: Translate) {
  return {
    section: t('auto.components.activity.ActivityThreadContextMenu.agentSection', 'Agent'),
    open: t('auto.components.activity.ActivityThreadContextMenu.open', 'Open'),
    copyTitle: t('auto.components.activity.ActivityThreadContextMenu.copyTitle', 'Copy Title'),
    markRead: t('auto.components.activity.ActivityThreadContextMenu.markRead', 'Mark Read'),
    markUnread: t('auto.components.activity.ActivityThreadContextMenu.markUnread', 'Mark Unread')
  }
}
