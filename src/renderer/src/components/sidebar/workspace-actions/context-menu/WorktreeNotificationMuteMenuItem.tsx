import { BellMinus, BellRing } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
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
  const t = useTranslate()
  const notificationsMuted = useAppStore(
    (s) => s.notificationsMutedByWorktree?.[worktreeId] === true
  )
  const toggleWorktreeNotificationsMuted = useAppStore((s) => s.toggleWorktreeNotificationsMuted)
  return (
    <DropdownMenuItem
      onSelect={() => toggleWorktreeNotificationsMuted(worktreeId)}
      disabled={disabled}
    >
      {/* Why: Mark Read already uses BellOff right above; BellMinus keeps the two rows distinct. */}
      {notificationsMuted ? <BellRing className="size-3.5" /> : <BellMinus className="size-3.5" />}
      {notificationsMuted
        ? t(
            'auto.components.sidebar.WorktreeContextMenu.unmuteNotifications',
            'Unmute Notifications'
          )
        : t('auto.components.sidebar.WorktreeContextMenu.muteNotifications', 'Mute Notifications')}
    </DropdownMenuItem>
  )
}
