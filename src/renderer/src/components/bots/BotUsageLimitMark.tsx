// A bot chat, worker or run stopped on its usage limit: the usage-limit row's amber gauge, the
// same whether Orca continues it at the reset or not; only the words and the tooltip differ.
import { Gauge } from 'lucide-react'
import { StateIndicatorTooltip } from '@/components/agent/status/StateIndicatorTooltip'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { formatUsageLimitResetClock } from '../../../../shared/agent-session/failures/agent-session-usage-limit'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import type {
  NamedUsageLimitStop,
  UsageLimitStop
} from '../../../../shared/bots/bot-usage-limit-stop'

/** A worker row's short meta: its name keeps the room; the mark's tooltip says the rest. */
export function usageLimitStopMeta(t: Translate, stop: UsageLimitStop): string {
  return stop.auto
    ? t('bots.usageLimit.continuesShort', 'Continues {{time}}', {
        time: formatUsageLimitResetClock(stop.at)
      })
    : t('bots.usageLimit.hitShort', 'Hit limit')
}

/** One line: the reassurance while Orca continues it, else whose limit stopped it. */
export function usageLimitStopTip(
  t: Translate,
  stop: Pick<NamedUsageLimitStop, 'at' | 'auto' | 'agent'>
): string {
  if (stop.auto) {
    return t('bots.usageLimit.continuesTip', 'Continues automatically at {{time}}', {
      time: formatUsageLimitResetClock(stop.at)
    })
  }
  const agent = isTuiAgent(stop.agent)
    ? getAgentLabel(stop.agent)
    : formatAgentTypeLabel(stop.agent)
  return t('bots.usageLimit.hitTip', '{{agent}} hit its usage limit · resets {{time}}', {
    agent,
    time: formatUsageLimitResetClock(stop.at)
  })
}

export function UsageLimitStopMark({
  stop,
  className
}: {
  stop: Pick<NamedUsageLimitStop, 'at' | 'auto' | 'agent'>
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const tip = usageLimitStopTip(t, stop)
  return (
    <StateIndicatorTooltip label={tip}>
      <span role="img" aria-label={tip} className="inline-flex shrink-0">
        <Gauge className={cn('size-3 text-status-warning', className)} aria-hidden />
      </span>
    </StateIndicatorTooltip>
  )
}
