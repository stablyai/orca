import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { formatResetCountdown } from '../../../../shared/rate-limit-reset-format'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  clampUsedPercent,
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { getWindowSections, ProviderIcon, barColor } from '../status-bar/tooltip'
import { getProviderDisplayName } from '../status-bar/usage-error-copy'
import { formatPlanLabel, usageTextColorClass } from '../status-bar/usage-roster-formatting'
import { translate } from '@/i18n/i18n'

type UsageSection = { label: string; window: RateLimitWindow }

function usedSections(provider: ProviderRateLimits): UsageSection[] {
  return getWindowSections(provider).filter(
    (section): section is UsageSection => section.window !== null && section.window !== undefined
  )
}

type UsageDashboardQuotaStripProps = {
  providers: ProviderRateLimits[]
  display: UsagePercentageDisplay
}

/** Subscription-window rows (session/weekly/monthly) per provider; quota rows ignore the scope toggle. */
export default function UsageDashboardQuotaStrip({
  providers,
  display
}: UsageDashboardQuotaStripProps): React.JSX.Element {
  const rows = providers
    .map((provider) => ({ provider, sections: usedSections(provider) }))
    .filter((row) => row.sections.length > 0)
  // One boundary-scheduled clock per strip keeps every reset countdown current without timers.
  const now = useResetCountdownClock(
    rows.flatMap((row) => row.sections.map((section) => section.window.resetsAt))
  )

  return (
    <section
      className="rounded-lg border border-border/60 bg-card/40 p-4"
      data-testid="usage-dashboard-quota-strip"
    >
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">
          {translate('auto.components.usageDashboard.UsageDashboardQuotaStrip.title', 'Quotas')}
        </h4>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.usageDashboard.UsageDashboardQuotaStrip.description',
            'Subscription windows reported by each provider. Scope does not change quotas.'
          )}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-xs text-muted-foreground">
          {translate(
            'auto.components.usageDashboard.UsageDashboardQuotaStrip.empty',
            'No subscription quotas reported yet.'
          )}
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map(({ provider, sections }) => {
            const plan = formatPlanLabel(provider.planType)
            const resetAt = sections.reduce<number | null>(
              (soonest, section) =>
                typeof section.window.resetsAt === 'number' &&
                Number.isFinite(section.window.resetsAt) &&
                (soonest === null || section.window.resetsAt < soonest)
                  ? section.window.resetsAt
                  : soonest,
              null
            )
            return (
              <div key={provider.provider} data-quota-provider={provider.provider}>
                <div className="flex items-center gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
                    <ProviderIcon provider={provider.provider} />
                  </span>
                  <span className="min-w-0 shrink truncate text-[13px] font-medium text-foreground">
                    {getProviderDisplayName(provider.provider)}
                    {plan ? (
                      <span className="font-normal text-muted-foreground"> · {plan}</span>
                    ) : null}
                  </span>
                  {resetAt !== null ? (
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                      {formatResetCountdown(resetAt - now)}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[30px]">
                  {sections.map((section) => {
                    const used = clampUsedPercent(section.window.usedPercent)
                    const shown = getDisplayedUsagePercentage(section.window.usedPercent, display)
                    return (
                      <span
                        key={section.label}
                        data-usage-window={section.label}
                        className="flex shrink-0 items-center gap-1.5"
                      >
                        <span className="text-[10px] text-muted-foreground">{section.label}</span>
                        <span className="h-[5px] w-10 overflow-hidden rounded-full bg-muted">
                          <span
                            className={`block h-full rounded-full ${barColor(used)}`}
                            style={{ width: `${shown}%` }}
                          />
                        </span>
                        <span className={`tabular-nums text-[11px] ${usageTextColorClass(used)}`}>
                          {shown}%
                        </span>
                      </span>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
