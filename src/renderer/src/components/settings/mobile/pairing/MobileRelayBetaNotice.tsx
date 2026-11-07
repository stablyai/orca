import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

// Retain the beta qualifier wherever public builds offer Relay.
export function MobileRelayBetaNotice({ className }: { className?: string }): React.JSX.Element {
  return (
    <p className={cn('text-[11px] text-muted-foreground', className)}>
      {translate('auto.components.settings.MobileRelayBetaNotice.notice', 'Orca Relay is in beta.')}
    </p>
  )
}
