import { SettingsSegmentedControl } from '@/components/settings/form-controls/SettingsSegmentedControl'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaBillingInterval } from '../../../../../shared/orca-billing'

/** Monthly / Annual on the shared segmented control (keyboard, contrast, reduced motion). */
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
  const save =
    savingsPercent === null
      ? null
      : t('auto.components.billing.plans.savePercent', 'Save {{value0}}%', {
          value0: String(savingsPercent)
        })
  return (
    <div className="mx-auto flex w-72 justify-center">
      <SettingsSegmentedControl<OrcaBillingInterval>
        value={value}
        onChange={onChange}
        size="sm"
        equalWidth
        ariaLabel={t('auto.components.billing.plans.billingPeriod', 'Billing period')}
        options={[
          {
            value: 'month',
            label: t('auto.components.billing.plans.monthly', 'Monthly'),
            disabled
          },
          {
            value: 'year',
            label: save ? (
              <span className="flex items-center gap-1.5">
                {t('auto.components.billing.plans.annual', 'Annual')}
                <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] font-semibold tabular-nums">
                  {save}
                </span>
              </span>
            ) : (
              t('auto.components.billing.plans.annual', 'Annual')
            ),
            ariaLabel: save
              ? `${t('auto.components.billing.plans.annual', 'Annual')}, ${save}`
              : undefined,
            disabled
          }
        ]}
      />
    </div>
  )
}
