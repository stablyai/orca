import { BellMinus, BellRing } from 'lucide-react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'

/** Context-menu toggle for per-tab notification mute. Mounted only while the menu is open,
 *  so the store subscription never runs per closed tab. */
export function TabNotificationMuteMenuItem({ tabId }: { tabId: string }): React.JSX.Element {
  const t = useTranslate()
  const notificationsMuted = useAppStore((s) => s.notificationsMutedByTabId?.[tabId] === true)
  const toggleTabNotificationsMuted = useAppStore((s) => s.toggleTabNotificationsMuted)
  return (
    <ContextMenuItem onSelect={() => toggleTabNotificationsMuted(tabId)}>
      {notificationsMuted ? (
        <BellRing className="size-3.5 shrink-0" />
      ) : (
        <BellMinus className="size-3.5 shrink-0" />
      )}
      {notificationsMuted
        ? t(
            'auto.components.sidebar.WorktreeContextMenu.unmuteNotifications',
            'Unmute Notifications'
          )
        : t('auto.components.sidebar.WorktreeContextMenu.muteNotifications', 'Mute Notifications')}
    </ContextMenuItem>
  )
}
