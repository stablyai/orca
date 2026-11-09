import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { OrcaBillingInterval } from '../../../../../shared/orca-billing'

/** Monthly / Annual switch with a sliding thumb (still under reduced motion). */
export function PlansIntervalToggle({
  value,
  savingsPercent,
  disabled,
  onChange
}: {
  value: OrcaBillingInterval
  savingsPercent: number | null
  disabled: boolean
  onChange: (interval: OrcaBillingInterval) => void
}): React.JSX.Element {
  const t = useTranslate()
  const options: { interval: OrcaBillingInterval; label: string; hint: string | null }[] = [
    { interval: 'month', label: t('auto.components.billing.plans.monthly', 'Monthly'), hint: null },
    {
      interval: 'year',
      label: t('auto.components.billing.plans.annual', 'Annual'),
      hint:
        savingsPercent === null
          ? null
          : t('auto.components.billing.plans.savePercent', 'Save {{value0}}%', {
              value0: String(savingsPercent)
            })
    }
  ]
  return (
    <div className="flex justify-center">
      <div
        role="group"
        aria-label={t('auto.components.billing.plans.billingPeriod', 'Billing period')}
        className="relative grid grid-cols-2 rounded-full border border-border bg-muted p-0.5"
      >
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full border border-border bg-background shadow-xs transition-transform duration-200 ease-out motion-reduce:transition-none dark:bg-secondary',
            value === 'year' && 'translate-x-full'
          )}
        />
        {options.map((option) => (
          <button
            key={option.interval}
            type="button"
            disabled={disabled}
            aria-pressed={value === option.interval}
            onClick={() => onChange(option.interval)}
            className={cn(
              'relative z-10 flex items-center justify-center gap-1.5 rounded-full px-4 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60',
              value === option.interval
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
            {option.hint ? (
              <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] font-semibold tabular-nums">
                {option.hint}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}
