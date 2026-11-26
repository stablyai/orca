import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { RateLimitWindow } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { formatResetsInCaption } from './usage-reset-caption'
import { UsageBar, UsageValue } from './usage-meter'

export function ProviderRateLimitWindowSection({
  window,
  label,
  textClass,
  mutedClass,
  emptyBarClass,
  usagePercentageDisplay,
  now
}: {
  window: RateLimitWindow | null
  label: string
  textClass: string
  mutedClass: string
  emptyBarClass: string
  usagePercentageDisplay: UsagePercentageDisplay
  now: number
}): React.JSX.Element | null {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  if (!window) {
    return null
  }
  const caption = formatResetsInCaption(window.resetsAt, now, intlLocale, t)

  return (
    <div className="space-y-1.5" data-usage-window={label}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate">
          <span className={`font-semibold ${textClass}`}>{label}</span>
          {caption ? <span className={mutedClass}>{` · ${caption}`}</span> : null}
        </span>
        <UsageValue
          usedPercent={window.usedPercent}
          display={usagePercentageDisplay}
          className={`shrink-0 font-semibold ${textClass}`}
        />
      </div>
      {/* Why: fill follows the selected percentage; only this card colors it by consumption. */}
      <UsageBar
        usedPercent={window.usedPercent}
        display={usagePercentageDisplay}
        tone="health"
        className="h-[6px] w-full"
        trackClassName={emptyBarClass}
      />
    </div>
  )
}
