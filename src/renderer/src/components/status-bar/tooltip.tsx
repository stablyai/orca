import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  formatResetCountdown,
  formatResetDuration
} from '../../../../shared/rate-limit-reset-format'
import { AgentIcon } from '@/lib/agent-catalog'
import { ClaudeIcon, GeminiIcon, MiniMaxIcon, OpenAIIcon, OpenCodeGoIcon } from './icons'
import { translate } from '@/i18n/i18n'
import {
  getProviderDisplayName,
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel
} from './usage-error-copy'
import {
  clampUsedPercent,
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { formatUsagePercentageLabel } from './usage-percentage-label'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { barColor, ProviderExtraUsageSection } from './provider-extra-usage-section'

export {
  barColor,
  getExtraUsageLabel,
  USAGE_URGENT_PERCENT,
  USAGE_WARNING_PERCENT
} from './provider-extra-usage-section'

export { clampUsedPercent }

export {
  getProviderDisplayName,
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel
} from './usage-error-copy'

export function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) {
    return translate('auto.components.status.bar.tooltip.justNow', 'just now')
  }
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) {
    return translate('auto.components.status.bar.tooltip.minutesAgo', '{{minutes}}m ago', {
      minutes: mins
    })
  }
  const hours = Math.floor(mins / 60)
  return translate('auto.components.status.bar.tooltip.hoursAgo', '{{hours}}h ago', { hours })
}

// Preserve tooltip imports while sharing countdown formatting with mobile.
export { formatResetCountdown }

export function formatResetCreditExpiry(
  expiresAt: number | null | undefined,
  count: number
): string | null {
  if (!expiresAt) {
    return null
  }
  const duration = formatResetDuration(expiresAt - Date.now())
  if (duration === 'now') {
    return count > 1
      ? translate('auto.components.status.bar.tooltip.7ec6e030a0', 'Next expires now')
      : translate('auto.components.status.bar.tooltip.d1e442a9e5', 'Expires now')
  }
  return count > 1
    ? translate('auto.components.status.bar.tooltip.6cf9eaed10', 'Next expires in {{value0}}', {
        value0: duration
      })
    : translate('auto.components.status.bar.tooltip.20ad66aed1', 'Expires in {{value0}}', {
        value0: duration
      })
}

export function ProviderIcon({ provider }: { provider: string }): React.JSX.Element {
  if (provider === 'codex') {
    return <OpenAIIcon size={13} />
  }
  if (provider === 'gemini') {
    return <GeminiIcon size={13} />
  }
  if (provider === 'opencode-go') {
    return <OpenCodeGoIcon size={13} />
  }
  if (provider === 'kimi') {
    return <AgentIcon agent="kimi" size={13} />
  }
  if (provider === 'antigravity') {
    return <AgentIcon agent="antigravity" size={13} />
  }
  if (provider === 'minimax') {
    return <MiniMaxIcon size={13} />
  }
  if (provider === 'grok') {
    return <AgentIcon agent="grok" size={13} />
  }
  if (provider === 'zcode') {
    return <AgentIcon agent="zcode" size={13} />
  }
  if (provider === 'cursor') {
    return <AgentIcon agent="cursor" size={13} />
  }
  return <ClaudeIcon size={13} />
}

function ErrorMessage({
  message,
  label,
  stale = false,
  inverted = false
}: {
  message: string
  label?: string
  /** When true, prior data is still visible — show a softer "refresh failed" label. */
  stale?: boolean
  inverted?: boolean
}): React.JSX.Element {
  const labelClass = inverted ? 'text-background/80' : 'text-foreground/85'
  const detailClass = inverted ? 'text-background/55' : 'text-muted-foreground'
  const genericRefreshLabel = translate(
    'auto.components.status.bar.tooltip.e740f92596',
    'Refresh failed'
  )
  const staleRefreshLabel = translate(
    'auto.components.status.bar.tooltip.a9a318b7a3',
    'Refresh failed — showing cached data'
  )
  const resolvedLabel =
    stale && (!label || label === genericRefreshLabel)
      ? staleRefreshLabel
      : (label ?? genericRefreshLabel)

  return (
    <div className="space-y-0.5">
      <div className={`text-[11px] font-medium ${labelClass}`}>{resolvedLabel}</div>
      <div className={detailClass}>{message}</div>
    </div>
  )
}

export function getWindowSections(
  p: ProviderRateLimits
): { label: string; window: RateLimitWindow | null }[] {
  if (p.buckets?.length) {
    const bucketSections = p.buckets.map((b) => ({ label: b.name, window: b as RateLimitWindow }))
    return [
      ...bucketSections,
      // Include Cursor’s monthly plan total because pools can understate proximity to its cap.
      ...(p.monthly
        ? [
            {
              label:
                p.provider === 'cursor'
                  ? translate('auto.components.status.bar.tooltip.cursor.plan', 'Plan')
                  : translate('auto.components.status.bar.tooltip.7f7f208060', 'Monthly'),
              window: p.monthly
            }
          ]
        : []),
      {
        label: translate('auto.components.status.bar.tooltip.252c096536', 'Weekly'),
        window: p.weekly
      }
    ]
  }
  const sections: { label: string; window: RateLimitWindow | null }[] = [
    {
      label: translate('auto.components.status.bar.tooltip.94038ad2fa', 'Session'),
      window: p.session
    },
    {
      label: translate('auto.components.status.bar.tooltip.252c096536', 'Weekly'),
      window: p.weekly
    }
  ]
  if (p.fableWeekly !== undefined && p.fableWeekly !== null) {
    sections.push({
      label: translate('auto.components.status.bar.tooltip.a79c64f87e', 'Fable'),
      window: p.fableWeekly
    })
  }
  if (p.monthly !== undefined && p.monthly !== null) {
    sections.push({
      label:
        p.provider === 'zcode'
          ? translate('auto.components.status.bar.tooltip.zcode.mcp', 'MCP')
          : translate('auto.components.status.bar.tooltip.7f7f208060', 'Monthly'),
      window: p.monthly
    })
  }
  return sections
}

// Tooltips invert the theme; use background text tokens for legible primary and secondary content.

function ProviderRateLimitWindowSection({
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
  if (!window) {
    return null
  }
  const usedPct = clampUsedPercent(window.usedPercent)
  const displayedPct = getDisplayedUsagePercentage(usedPct, usagePercentageDisplay)
  const resetLabel = window.resetsAt ? formatResetCountdown(window.resetsAt - now) : null

  return (
    <div className="space-y-1">
      <div className={`font-medium ${textClass}`}>{label}</div>
      <div className={`h-[6px] w-full overflow-hidden rounded-full ${emptyBarClass}`}>
        {/* Why: fill follows the selected percentage; color still signals consumption urgency. */}
        <div
          className={`h-full rounded-full ${barColor(usedPct)} transition-all duration-300`}
          style={{ width: `${displayedPct}%` }}
        />
      </div>
      <div className={`flex justify-between ${mutedClass}`}>
        <span>{formatUsagePercentageLabel(usedPct, usagePercentageDisplay)}</span>
        {resetLabel && <span>{resetLabel}</span>}
      </div>
    </div>
  )
}

export function ProviderPanel({
  p,
  inverted = false,
  className,
  showResetCredits = true,
  usagePercentageDisplay = 'used'
}: {
  p: ProviderRateLimits | null
  inverted?: boolean
  className?: string
  showResetCredits?: boolean
  usagePercentageDisplay?: UsagePercentageDisplay
}): React.JSX.Element {
  const windowSections = p ? getWindowSections(p) : []
  const now = useResetCountdownClock(windowSections.map((section) => section.window?.resetsAt))
  const textClass = inverted ? 'text-background' : 'text-foreground'
  const mutedClass = inverted ? 'text-background/60' : 'text-muted-foreground'
  const faintClass = inverted ? 'text-background/50' : 'text-muted-foreground/80'
  const dividerClass = inverted ? 'border-background/15' : 'border-border/70'
  const emptyBarClass = inverted ? 'bg-background/20' : 'bg-muted'

  if (!p) {
    return (
      <span className={`text-xs ${mutedClass}`}>
        {translate('auto.components.status.bar.tooltip.6d6df77f41', 'No data available')}
      </span>
    )
  }

  const name = getProviderDisplayName(p.provider)

  if (p.status === 'unavailable') {
    return (
      <div className={`text-xs ${className ?? 'w-full'}`}>
        <div className={`flex items-center gap-1.5 font-medium ${textClass}`}>
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className={mutedClass}>
          {p.error ?? translate('auto.components.status.bar.tooltip.1292d4f2ee', 'Unavailable')}
        </div>
      </div>
    )
  }

  if (p.status === 'error' && !p.session && !p.weekly && !p.fableWeekly && !p.monthly) {
    return (
      <div className={`text-xs ${className ?? 'w-full'}`}>
        <div className={`flex items-center gap-1.5 font-medium ${textClass}`}>
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className="mt-2">
          <ErrorMessage
            label={getProviderUsageStatusLabel(p)}
            message={getProviderUsageErrorMessage(p)}
            inverted={inverted}
          />
        </div>
      </div>
    )
  }

  const updatedAgo = p.updatedAt
    ? translate('auto.components.status.bar.tooltip.updatedAgo', 'Updated {{time}}', {
        time: formatTimeAgo(p.updatedAt)
      })
    : translate('auto.components.status.bar.tooltip.notYetUpdated', 'Not yet updated')
  const resetCreditCount =
    showResetCredits && p.provider === 'codex'
      ? (p.rateLimitResetCredits?.availableCount ?? null)
      : null
  const resetCreditExpiry =
    resetCreditCount != null
      ? formatResetCreditExpiry(p.rateLimitResetCredits?.nextExpiresAt, resetCreditCount)
      : null

  return (
    <div className={`${className ?? 'w-full'} space-y-3 text-xs`}>
      <div>
        <div className={`flex items-center gap-1.5 text-[13px] font-medium ${textClass}`}>
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className={faintClass}>{updatedAgo}</div>
        {resetCreditCount !== null && resetCreditCount !== undefined ? (
          <div className={mutedClass}>
            {translate(
              'auto.components.status.bar.tooltip.rateLimitResetsAvailable',
              '{{count}} rate-limit resets available',
              { count: resetCreditCount, defaultValue_one: '{{count}} rate-limit reset available' }
            )}
          </div>
        ) : null}
        {resetCreditExpiry ? <div className={faintClass}>{resetCreditExpiry}</div> : null}
      </div>

      <div className={`border-t ${dividerClass}`} />

      {windowSections.map((s) => (
        <ProviderRateLimitWindowSection
          key={s.label}
          window={s.window}
          label={s.label}
          textClass={textClass}
          mutedClass={mutedClass}
          emptyBarClass={emptyBarClass}
          usagePercentageDisplay={usagePercentageDisplay}
          now={now}
        />
      ))}

      {p.extraUsage ? (
        <ProviderExtraUsageSection
          balance={p.extraUsage}
          provider={p.provider}
          textClass={textClass}
          mutedClass={mutedClass}
          faintClass={faintClass}
          emptyBarClass={emptyBarClass}
          usagePercentageDisplay={usagePercentageDisplay}
        />
      ) : null}

      {p.error ? (
        <ErrorMessage
          message={p.error}
          stale={!!(p.session || p.weekly || p.fableWeekly || p.monthly)}
          inverted={inverted}
        />
      ) : null}
    </div>
  )
}
