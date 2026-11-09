import { Badge } from '@/components/ui/badge'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'
import { statusLabel } from './plan-billing-copy'

export type PlanHealth = { label: string; dot: 'destructive' | 'warning' | null }

/** Names what is actually wrong (not just Stripe's status) so the badge never says "Active" in red. */
export function planHealth(entitlement: OrcaBillingEntitlement, t: Translate): PlanHealth {
  if (entitlement.reason === 'payment_grace_expired' || entitlement.payment.suspendRunning) {
    return { label: t('auto.components.billing.health.suspended', 'Suspended'), dot: 'destructive' }
  }
  if (entitlement.payment.pastDueSince !== null || entitlement.status === 'past_due') {
    return { label: t('auto.components.billing.statusPastDue', 'Payment due'), dot: 'destructive' }
  }
  if (entitlement.reason === 'overage_cap_reached') {
    return { label: t('auto.components.billing.health.capReached', 'Cap reached'), dot: 'warning' }
  }
  if (entitlement.reason === 'included_hours_exhausted') {
    return { label: t('auto.components.billing.health.hoursUsed', 'Hours used up'), dot: 'warning' }
  }
  if (entitlement.cancelAtPeriodEnd) {
    return { label: t('auto.components.billing.health.ending', 'Ending'), dot: 'warning' }
  }
  return { label: statusLabel(entitlement.status, t), dot: null }
}

/** Quiet outline badge; a small dot carries the alarm. Banners elsewhere explain what to do. */
export function PlanStatusBadge({
  entitlement,
  className
}: {
  entitlement: OrcaBillingEntitlement
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const health = planHealth(entitlement, t)
  return (
    <Badge variant="outline" className={cn('gap-1.5', className)}>
      {health.dot ? (
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full',
            health.dot === 'destructive' ? 'bg-destructive' : 'bg-amber-500'
          )}
        />
      ) : null}
      {health.label}
    </Badge>
  )
}
