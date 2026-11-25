import { BellOff } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'

/** Title-row bell-off mark for a worktree whose notifications the user muted; renders nothing otherwise. */
export function WorktreeCardNotificationsMutedBadge({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  // Boolean selector: a card re-renders only when its own mute flips.
  const muted = useAppStore((s) => s.notificationsMutedByWorktree?.[worktreeId] === true)
  if (!muted) {
    return null
  }
  const label = t('auto.components.sidebar.WorktreeCard.notificationsMuted', 'Notifications muted')
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-worktree-card-muted-indicator=""
      className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/70"
    >
      <BellOff className="size-3" aria-hidden="true" />
    </span>
  )
}
