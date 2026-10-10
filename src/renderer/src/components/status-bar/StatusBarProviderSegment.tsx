import { AlertTriangle } from 'lucide-react'
import React from 'react'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { formatCurrencyAmount } from '../../../../shared/currency-format'
import { formatCreditCount } from '../../../../shared/credit-count-format'
import {
  ProviderIcon,
  USAGE_URGENT_PERCENT,
  USAGE_WARNING_PERCENT,
  clampUsedPercent,
  getProviderDisplayName,
  getProviderUsageStatusLabel
} from './tooltip'
import { isClaudeUsageWaitingForClaude } from './usage-error-copy'
import { getTightestUsageSection, getUsageHeadlineSection } from './UsageRosterPanel'
import { formatBareUsagePercentage, formatUsagePercentageLabel } from './usage-percentage-label'
import { translate } from '@/i18n/i18n'
import { getStatusBarUsageSections } from './status-bar-usage-sections'

function MiniBar({
  usedPct,
  display
}: {
  usedPct: number
  display: UsagePercentageDisplay
}): React.JSX.Element {
  return (
    <div
      data-usage-bar
      className="w-[48px] h-[6px] rounded-full bg-muted overflow-hidden flex-shrink-0"
    >
      <div
        className="h-full rounded-full transition-all duration-300 bg-muted-foreground/40"
        style={{ width: `${getDisplayedUsagePercentage(usedPct, display)}%` }}
      />
    </div>
  )
}

function WindowLabel({
  w,
  label,
  display,
  showLabel = true,
  labelFirst = false
}: {
  w: RateLimitWindow
  label: string
  display: UsagePercentageDisplay
  showLabel?: boolean
  labelFirst?: boolean
}): React.JSX.Element {
  return (
    <span className="tabular-nums">
      {showLabel && labelFirst ? `${label} ` : ''}
      {formatBareUsagePercentage(w.usedPercent, display)}
      {showLabel && !labelFirst ? ` ${label}` : ''}
    </span>
  )
}

// Single-letter provider badge for the icon-only (narrow) status bar. Shared by
// the roster trigger and ProviderDetailsMenu so the dot's has-data condition
// and markup can't drift between the two.
export function ProviderLetterBadge({ p }: { p: ProviderRateLimits }): React.JSX.Element {
  const hasData = Boolean(p.session || p.weekly || p.fableWeekly || p.monthly || p.buckets?.length)
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <span
        className={`inline-block h-2 w-2 rounded-full ${hasData ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30'}`}
      />
      {getProviderLetter(p.provider)}
    </span>
  )
}

export type UsageTone = 'urgent' | 'warning' | 'normal'

/** Urgency by consumption, matching the usage bar colors, whatever % display the user chose. */
export function getUsageTone(p: ProviderRateLimits): UsageTone {
  const tightest = getTightestUsageSection(p)
  const used = tightest ? clampUsedPercent(tightest.window.usedPercent) : 0
  return used >= USAGE_URGENT_PERCENT
    ? 'urgent'
    : used >= USAGE_WARNING_PERCENT
      ? 'warning'
      : 'normal'
}

/**
 * Stands in for usage chips a narrow bar can't fit. Always rendered at the collapsing
 * density so its width is known before anything collapses; out of the row while empty.
 */
export function UsageOverflowChip({
  hidden,
  providerCount,
  display
}: {
  hidden: readonly ProviderRateLimits[]
  providerCount: number
  display: UsagePercentageDisplay
}): React.JSX.Element {
  const tones = hidden.map(getUsageTone)
  const tone = tones.includes('urgent')
    ? 'urgent'
    : tones.includes('warning')
      ? 'warning'
      : 'normal'
  const names = hidden
    .map((p) => {
      const tightest = getTightestUsageSection(p)
      const name = getProviderDisplayName(p.provider)
      return tightest
        ? `${name} ${formatUsagePercentageLabel(tightest.window.usedPercent, display)}`
        : name
    })
    .join(', ')
  return (
    <span
      data-usage-more
      data-usage-collapsed={hidden.length === 0}
      data-tone={tone}
      aria-hidden={hidden.length === 0}
      title={translate(
        'auto.components.status.bar.StatusBar.hiddenUsageProviders',
        'Also: {{value0}}',
        {
          value0: names
        }
      )}
      className="inline-grid h-4 items-center justify-items-center rounded-full border border-border px-1.5 text-[11px] font-medium tabular-nums text-foreground data-[tone=urgent]:border-destructive/40 data-[tone=urgent]:text-destructive data-[tone=warning]:border-status-warning-border data-[tone=warning]:text-status-warning data-[usage-collapsed=true]:invisible data-[usage-collapsed=true]:absolute"
    >
      {/* Why: count changes must not invalidate density measurements and restart probing. */}
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        +{providerCount}
      </span>
      <span className="col-start-1 row-start-1">+{Math.max(1, hidden.length)}</span>
    </span>
  )
}

function getProviderLetter(provider: ProviderRateLimits['provider']): string {
  switch (provider) {
    case 'claude':
      return 'C'
    case 'gemini':
      return 'G'
    case 'opencode-go':
      return 'O'
    case 'kimi':
      return 'K'
    case 'antigravity':
      return 'A'
    case 'minimax':
      return 'M'
    case 'grok':
      return 'R'
    case 'cursor':
      return 'U'
    case 'zcode':
      return 'Z'
    case 'codex':
      return 'X'
  }
}

// ---------------------------------------------------------------------------
// Provider segment
// ---------------------------------------------------------------------------

// A plan spends into its overage balance only once an included window is
// exhausted. Treat ~100% as capped to tolerate provider rounding.
const CAP_THRESHOLD_PERCENT = 99.5

// Why: only reveal the compact balance once a capped window can spend it.
function isExtraUsageActive(p: ProviderRateLimits): boolean {
  if (
    !p.extraUsage ||
    !p.extraUsage.enabled ||
    (p.extraUsage.unit === 'currency' &&
      (p.extraUsage.balance === null || p.extraUsage.balance <= 0))
  ) {
    return false
  }
  return [p.session, p.weekly, p.monthly, p.fableWeekly].some(
    (w) => w != null && clampUsedPercent(w.usedPercent) >= CAP_THRESHOLD_PERCENT
  )
}

function formatCompactExtraUsage(balance: ProviderRateLimits['extraUsage']): string {
  if (!balance) {
    return ''
  }
  if (balance.unit === 'credits') {
    return balance.unlimited
      ? translate('auto.components.status.bar.StatusBar.4025a6f62f', 'Unlimited')
      : translate('auto.components.status.bar.StatusBar.a95969101f', '{{value0}} credits', {
          value0: formatCreditCount(balance.balance)
        })
  }
  return balance.balance === null
    ? ''
    : translate('auto.components.status.bar.StatusBar.4fba7dc1e7', '{{value0}} bal', {
        value0: formatCurrencyAmount(balance.balance, balance.currencyCode)
      })
}

export function ProviderSegment({
  p,
  compact,
  display,
  mode = 'verbose'
}: {
  p: ProviderRateLimits | null
  compact: boolean
  display: UsagePercentageDisplay
  mode?: StatusBarUsageMode
}): React.JSX.Element {
  const provider = p?.provider ?? 'claude'
  const statusLabel = p ? getProviderUsageStatusLabel(p) : ''
  // Why: not a problem; Claude updates its own login the next time it runs.
  const calm = p ? isClaudeUsageWaitingForClaude(p) : false

  // Idle / initial load
  if (!p || p.status === 'idle') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <span className="animate-pulse">···</span>
      </span>
    )
  }

  const tightest = mode === 'compact' ? getUsageHeadlineSection(p) : getTightestUsageSection(p)

  // Fetching with no prior data
  if (p.status === 'fetching' && !tightest) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <span className="animate-pulse">···</span>
      </span>
    )
  }

  // Unavailable (CLI not installed)
  if (p.status === 'unavailable') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground/50">
        <ProviderIcon provider={provider} /> --
      </span>
    )
  }

  // Error with no data
  if (p.status === 'error' && !tightest) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        {!calm && <AlertTriangle size={11} className="text-muted-foreground/80" />}
        {!compact && <span className="text-[11px] font-medium">{statusLabel}</span>}
      </span>
    )
  }

  // Has data (ok, fetching with stale data, or error with stale data)
  const isStale = p.status === 'error' && !calm
  const showBalance = isExtraUsageActive(p)
  const sections = getStatusBarUsageSections(p, mode)

  return (
    <span className="inline-flex items-center gap-1.5">
      <ProviderIcon provider={provider} />
      {mode === 'verbose' && tightest && !compact ? (
        <MiniBar usedPct={clampUsedPercent(tightest.window.usedPercent)} display={display} />
      ) : null}
      {sections.map((section, index) => (
        <React.Fragment key={section.key}>
          {index > 0 ? <span className="text-muted-foreground">·</span> : null}
          <WindowLabel
            w={section.window}
            label={section.label}
            display={display}
            showLabel={mode === 'verbose' || !compact}
            labelFirst={section.labelFirst}
          />
        </React.Fragment>
      ))}
      {showBalance && p.extraUsage ? (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="tabular-nums">{formatCompactExtraUsage(p.extraUsage)}</span>
        </>
      ) : null}
      {isStale && <AlertTriangle size={11} className="text-muted-foreground/80" />}
    </span>
  )
}
