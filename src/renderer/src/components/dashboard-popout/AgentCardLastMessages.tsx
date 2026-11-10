import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

export function hasAgentCardLastMessages(card: DashboardCard): boolean {
  return Boolean(card.lastUserMessage || card.lastAgentMessage)
}

/** Kanban cards clamp to a glance; the dialog shows the stored preview unclamped. */
export function AgentCardLastMessages({
  card,
  clamp,
  className
}: {
  card: DashboardCard
  clamp: boolean
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className={cn('flex w-full flex-col gap-0.5', className)}>
      {card.lastUserMessage ? (
        <div
          className={cn(
            'text-2xs leading-snug text-muted-foreground',
            clamp ? 'line-clamp-1' : 'whitespace-pre-wrap break-words'
          )}
        >
          <span className="font-medium text-foreground/45">
            {t('dashboardPopout.card.you', 'You')}
          </span>{' '}
          {card.lastUserMessage}
        </div>
      ) : null}
      {card.lastAgentMessage ? (
        <div
          className={cn(
            'text-xs leading-snug text-foreground/90',
            clamp ? 'line-clamp-2' : 'whitespace-pre-wrap break-words'
          )}
        >
          <span className="font-medium text-foreground/45">
            {formatAgentTypeLabel(card.agentType)}
          </span>{' '}
          {card.lastAgentMessage}
        </div>
      ) : null}
    </div>
  )
}
