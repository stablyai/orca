import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

// Retain the beta qualifier wherever public builds offer Relay.
export function MobileRelayBetaNotice({ className }: { className?: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className={cn('text-[11px] text-muted-foreground', className)}>
      {t('auto.components.settings.MobileRelayBetaNotice.notice', 'Orca Relay is in beta.')}
    </p>
  )
}
