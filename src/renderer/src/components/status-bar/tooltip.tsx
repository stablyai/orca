import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  formatResetCountdown,
  formatResetDuration
} from '../../../../shared/rate-limit-reset-format'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { ClaudeIcon, GeminiIcon, MiniMaxIcon, OpenAIIcon, OpenCodeGoIcon } from './icons'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { Translate } from '@/i18n/use-translate'
import {
  getProviderDisplayName,
  getUsageWindowSections,
  type UsageWindowSection
} from '../../../../shared/usage-provider-windows'
import { getProviderUsageErrorMessage, getProviderUsageStatusLabel } from './usage-error-copy'
import {
  clampUsedPercent,
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { formatUsagePercentageLabel } from './usage-percentage-label'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { recomputeOn } from '@/lib/recompute-on'
import { barColor, ProviderExtraUsageSection } from './provider-extra-usage-section'

export {
  barColor,
  getExtraUsageLabel,
  USAGE_URGENT_PERCENT,
  USAGE_WARNING_PERCENT
} from './provider-extra-usage-section'

export { clampUsedPercent }

export { getProviderUsageErrorMessage, getProviderUsageStatusLabel } from './usage-error-copy'

export function formatTimeAgo(ts: number, t: Translate = translate): string {
  const diff = Date.now() - ts
  if (diff < 60_000) {
    return t('auto.components.status.bar.tooltip.justNow', 'just now')
  }
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) {
    return t('auto.components.status.bar.tooltip.minutesAgo', '{{minutes}}m ago', {
      minutes: mins
    })
  }
  const hours = Math.floor(mins / 60)
  return t('auto.components.status.bar.tooltip.hoursAgo', '{{hours}}h ago', { hours })
}

// Preserve tooltip imports while sharing countdown formatting with mobile.
export { formatResetCountdown }

export function formatResetCreditExpiry(
  expiresAt: number | null | undefined,
  count: number,
  t: Translate = translate,
  /** Lowercase clause that follows "N resets available ·" on one line. */
  { inline = false }: { inline?: boolean } = {}
): string | null {
  if (!expiresAt) {
    return null
  }
  const duration = formatResetDuration(expiresAt - Date.now())
  if (duration === 'now') {
    if (inline) {
      return count > 1
        ? t('auto.components.status.bar.tooltip.inlineNextExpiresNow', 'next expires now')
        : t('auto.components.status.bar.tooltip.inlineExpiresNow', 'expires now')
    }
    return count > 1
      ? t('auto.components.status.bar.tooltip.7ec6e030a0', 'Next expires now')
      : t('auto.components.status.bar.tooltip.d1e442a9e5', 'Expires now')
  }
  if (inline) {
    return count > 1
      ? t('auto.components.status.bar.tooltip.inlineNextExpiresIn', 'next expires in {{value0}}', {
          value0: duration
        })
      : t('auto.components.status.bar.tooltip.inlineExpiresIn', 'expires in {{value0}}', {
          value0: duration
        })
  }
  return count > 1
    ? t('auto.components.status.bar.tooltip.6cf9eaed10', 'Next expires in {{value0}}', {
        value0: duration
      })
    : t('auto.components.status.bar.tooltip.20ad66aed1', 'Expires in {{value0}}', {
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
  if (provider === 'muse') {
    return <AgentIcon agent="muse" size={13} />
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
  const t = useTranslate()
  const labelClass = inverted ? 'text-background/80' : 'text-foreground/85'
  const detailClass = inverted ? 'text-background/55' : 'text-muted-foreground'
  const genericRefreshLabel = t('auto.components.status.bar.tooltip.e740f92596', 'Refresh failed')
  const staleRefreshLabel = t(
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
  p: ProviderRateLimits,
  t?: Translate
): { label: string; window: RateLimitWindow | null }[] {
  return getUsageWindowSections(p).map((section) => ({
    label: getWindowSectionLabel(section, t),
    window: section.window
  }))
}

function getWindowSectionLabel(section: UsageWindowSection, t: Translate = translate): string {
  switch (section.kind) {
    case 'bucket':
      return section.name
    case 'session':
      return t('auto.components.status.bar.tooltip.94038ad2fa', 'Session')
    case 'weekly':
      return t('auto.components.status.bar.tooltip.252c096536', 'Weekly')
    case 'fableWeekly':
      return t('auto.components.status.bar.tooltip.a79c64f87e', 'Fable')
    case 'monthly':
      return t('auto.components.status.bar.tooltip.7f7f208060', 'Monthly')
    case 'plan':
      return t('auto.components.status.bar.tooltip.cursor.plan', 'Plan')
    case 'mcp':
      return t('auto.components.status.bar.tooltip.zcode.mcp', 'MCP')
  }
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
  const t = useTranslate()
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
        <span>{formatUsagePercentageLabel(usedPct, usagePercentageDisplay, t)}</span>
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
  usagePercentageDisplay = 'used',
  embedded = false
}: {
  p: ProviderRateLimits | null
  inverted?: boolean
  className?: string
  showResetCredits?: boolean
  usagePercentageDisplay?: UsagePercentageDisplay
  /** Inside an account card that already names the provider; tracks must contrast with the card. */
  embedded?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const windowSections = p ? getWindowSections(p, t) : []
  const now = useResetCountdownClock(windowSections.map((section) => section.window?.resetsAt))
  const textClass = inverted ? 'text-background' : 'text-foreground'
  const mutedClass = inverted ? 'text-background/60' : 'text-muted-foreground'
  const faintClass = inverted ? 'text-background/50' : 'text-muted-foreground/80'
  const dividerClass = inverted ? 'border-background/15' : 'border-border/70'
  const emptyBarClass = inverted ? 'bg-background/20' : embedded ? 'bg-foreground/10' : 'bg-muted'

  if (!p) {
    return (
      <span className={`text-xs ${mutedClass}`}>
        {t('auto.components.status.bar.tooltip.6d6df77f41', 'No data available')}
      </span>
    )
  }

  const name = getProviderDisplayName(p.provider)

  if (p.status === 'unavailable') {
    return (
      <div className={`text-xs ${className ?? 'w-full'}`}>
        {embedded ? null : (
          <div className={`flex items-center gap-1.5 font-medium ${textClass}`}>
            <ProviderIcon provider={p.provider} />
            {name}
          </div>
        )}
        <div className={mutedClass}>
          {p.error ?? t('auto.components.status.bar.tooltip.1292d4f2ee', 'Unavailable')}
        </div>
      </div>
    )
  }

  if (p.status === 'error' && !p.session && !p.weekly && !p.fableWeekly && !p.monthly) {
    return (
      <div className={`text-xs ${className ?? 'w-full'}`}>
        {embedded ? null : (
          <div className={`flex items-center gap-1.5 font-medium ${textClass}`}>
            <ProviderIcon provider={p.provider} />
            {name}
          </div>
        )}
        <div className={embedded ? undefined : 'mt-2'}>
          <ErrorMessage
            label={getProviderUsageStatusLabel(p, t)}
            message={getProviderUsageErrorMessage(p, t)}
            inverted={inverted}
          />
        </div>
      </div>
    )
  }

  const updatedAt = p.updatedAt
  // Why: both labels read Date.now(); recomputeOn ties React Compiler's cache to the clock tick.
  const updatedAgo = updatedAt
    ? t('auto.components.status.bar.tooltip.updatedAgo', 'Updated {{time}}', {
        time: recomputeOn([now], () => formatTimeAgo(updatedAt, t))
      })
    : t('auto.components.status.bar.tooltip.notYetUpdated', 'Not yet updated')
  const resetCreditCount =
    showResetCredits && p.provider === 'codex'
      ? (p.rateLimitResetCredits?.availableCount ?? null)
      : null
  const resetCreditExpiry =
    resetCreditCount != null
      ? recomputeOn([now], () =>
          formatResetCreditExpiry(p.rateLimitResetCredits?.nextExpiresAt, resetCreditCount, t)
        )
      : null

  return (
    <div className={`${className ?? 'w-full'} space-y-3 text-xs`}>
      {!embedded ? (
        <div>
          <div className={`flex items-center gap-1.5 text-[13px] font-medium ${textClass}`}>
            <ProviderIcon provider={p.provider} />
            {name}
          </div>
          <div className={faintClass}>{updatedAgo}</div>
          {resetCreditCount !== null && resetCreditCount !== undefined ? (
            <div className={mutedClass}>
              {t(
                'auto.components.status.bar.tooltip.rateLimitResetsAvailable',
                '{{count}} rate-limit resets available',
                {
                  count: resetCreditCount,
                  defaultValue_one: '{{count}} rate-limit reset available'
                }
              )}
            </div>
          ) : null}
          {resetCreditExpiry ? <div className={faintClass}>{resetCreditExpiry}</div> : null}
        </div>
      ) : null}

      {embedded ? null : <div className={`border-t ${dividerClass}`} />}

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
