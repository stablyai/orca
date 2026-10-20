import { BellOff, BellRing } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

/** Context-menu toggle for the per-worktree notification mute. Mounted only
 *  while the menu is open, so the store subscription never runs per closed card. */
export function WorktreeNotificationMuteMenuItem({
  worktreeId,
  disabled
}: {
  worktreeId: string
  disabled: boolean
}): React.JSX.Element {
  const notificationsMuted = useAppStore(
    (s) => s.notificationsMutedByWorktree?.[worktreeId] === true
  )
  const toggleWorktreeNotificationsMuted = useAppStore((s) => s.toggleWorktreeNotificationsMuted)
  return (
    <DropdownMenuItem
      onSelect={() => toggleWorktreeNotificationsMuted(worktreeId)}
      disabled={disabled}
    >
      {notificationsMuted ? <BellRing className="size-3.5" /> : <BellOff className="size-3.5" />}
      {notificationsMuted
        ? translate(
            'auto.components.sidebar.WorktreeContextMenu.unmuteNotifications',
            'Unmute Notifications'
          )
        : translate(
            'auto.components.sidebar.WorktreeContextMenu.muteNotifications',
            'Mute Notifications'
          )}
    </DropdownMenuItem>
  )
}
