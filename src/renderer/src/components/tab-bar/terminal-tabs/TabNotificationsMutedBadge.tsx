import { BellOff } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'

/** Bell-off indicator for a tab whose notifications the user muted; renders nothing otherwise. */
export function TabNotificationsMutedBadge({ tabId }: { tabId: string }): React.JSX.Element | null {
  const t = useTranslate()
  // Boolean selector: a tab re-renders only when its own mute flips.
  const muted = useAppStore((s) => s.notificationsMutedByTabId?.[tabId] === true)
  if (!muted) {
    return null
  }
  const label = t('auto.components.sidebar.WorktreeCard.notificationsMuted', 'Notifications muted')
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-tab-muted-indicator=""
      className="mr-1 inline-flex shrink-0 items-center justify-center text-muted-foreground/70"
    >
      <BellOff className="size-3" aria-hidden="true" />
    </span>
  )
}
