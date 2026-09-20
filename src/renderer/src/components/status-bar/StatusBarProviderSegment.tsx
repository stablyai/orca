import { AlertTriangle } from 'lucide-react'
import React from 'react'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { DEFAULT_STATUS_BAR_USAGE_BARS_VISIBLE } from '../../../../shared/status-bar-usage-bars'
import {
  DEFAULT_STATUS_BAR_USAGE_CHIP_PARTS,
  type StatusBarUsageChipParts
} from '../../../../shared/status-bar-usage-chip-format'
import { ProviderIcon, clampUsedPercent, getProviderUsageStatusLabel } from './tooltip'
import { getTightestUsageSection } from './UsageRosterPanel'
import { formatRateLimitWindowChipLabel } from '@/lib/window-label-formatter'
import { formatUsagePercentageLabel, formatUsagePercentageValue } from './usage-percentage-label'
import { translate } from '@/i18n/i18n'

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
  format,
  showLabel = true
}: {
  w: RateLimitWindow
  label: string
  display: UsagePercentageDisplay
  format: StatusBarUsageChipParts
  showLabel?: boolean
}): React.JSX.Element {
  const percentage = format.statusBarUsageChipDisplayWord
    ? formatUsagePercentageLabel(w.usedPercent, display)
    : formatUsagePercentageValue(w.usedPercent, display)
  // With the word present the chip keeps the space it has always had; without
  // it a comma joins the pair so the halves still read as one value.
  const separator = format.statusBarUsageChipDisplayWord ? ' ' : ', '
  const withLabel = showLabel && format.statusBarUsageChipWindowLabel
  return (
    // Why nowrap: the chip is one value. Left to wrap, flex breaks it at the
    // space and strands the countdown on a second row under the percentage,
    // which reads as two separate readings rather than one.
    <span className="whitespace-nowrap tabular-nums">
      {percentage}
      {withLabel ? `${separator}${label}` : ''}
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
    case 'codex':
      return 'X'
  }
}

// ---------------------------------------------------------------------------
// Provider segment
// ---------------------------------------------------------------------------

// Why: Gemini exposes extra experimental buckets that made the pre-existing verbose footer noisy.
const STATUS_BAR_BUCKET_NAMES = new Set(['Flash', 'Pro', '1.5 Pro'])

function VerboseProviderUsage({
  p,
  display,
  format
}: {
  p: ProviderRateLimits
  display: UsagePercentageDisplay
  format: StatusBarUsageChipParts
}): React.JSX.Element {
  // Why not pass Date.now() here: reading the clock during render is impure and
  // the react(purity) lint rejects it. Leaving `now` undefined keeps the clock
  // read inside the formatter's default parameter, exactly where it was before.
  const chipLabel = (window: RateLimitWindow): string =>
    formatRateLimitWindowChipLabel(window, undefined, {
      tight: format.statusBarUsageChipTightDuration
    })
  if (p.buckets && p.buckets.length > 0) {
    const visibleBuckets = p.buckets.filter((bucket) => STATUS_BAR_BUCKET_NAMES.has(bucket.name))
    return (
      <>
        {visibleBuckets.map((bucket, index) => (
          <React.Fragment key={bucket.name}>
            {index > 0 ? <span className="text-muted-foreground">·</span> : null}
            <span className="whitespace-nowrap tabular-nums">
              {bucket.name}{' '}
              {format.statusBarUsageChipDisplayWord
                ? formatUsagePercentageLabel(bucket.usedPercent, display)
                : formatUsagePercentageValue(bucket.usedPercent, display)}
            </span>
          </React.Fragment>
        ))}
        {visibleBuckets.length === 0 && p.session ? (
          <WindowLabel
            w={p.session}
            label={chipLabel(p.session)}
            display={display}
            format={format}
          />
        ) : null}
      </>
    )
  }

  const visibleWindows = [
    p.session
      ? {
          key: 'session',
          window: p.session,
          label: chipLabel(p.session)
        }
      : null,
    p.weekly
      ? {
          key: 'weekly',
          window: p.weekly,
          label: chipLabel(p.weekly)
        }
      : null,
    p.fableWeekly
      ? {
          key: 'fableWeekly',
          window: p.fableWeekly,
          label: translate('auto.components.status.bar.StatusBar.a79c64f87e', 'Fable')
        }
      : null,
    // Why: monthly stays inline for monthly-only providers; otherwise the detail panel carries it.
    p.monthly && !p.session && !p.weekly
      ? {
          key: 'monthly',
          window: p.monthly,
          label: chipLabel(p.monthly)
        }
      : null
  ].filter((window): window is { key: string; window: RateLimitWindow; label: string } => {
    return window !== null
  })

  return (
    <>
      {visibleWindows.map((window, index) => (
        <React.Fragment key={window.key}>
          {index > 0 ? <span className="text-muted-foreground">·</span> : null}
          <WindowLabel w={window.window} label={window.label} display={display} format={format} />
        </React.Fragment>
      ))}
    </>
  )
}

export function ProviderSegment({
  p,
  compact,
  display,
  mode = 'verbose',
  barsVisible = DEFAULT_STATUS_BAR_USAGE_BARS_VISIBLE,
  chipFormat = DEFAULT_STATUS_BAR_USAGE_CHIP_PARTS
}: {
  p: ProviderRateLimits | null
  compact: boolean
  display: UsagePercentageDisplay
  mode?: StatusBarUsageMode
  barsVisible?: boolean
  chipFormat?: StatusBarUsageChipParts
}): React.JSX.Element {
  const provider = p?.provider ?? 'claude'
  const statusLabel = p ? getProviderUsageStatusLabel(p) : ''

  // Idle / initial load
  if (!p || p.status === 'idle') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <span className="animate-pulse">···</span>
      </span>
    )
  }

  const tightest = getTightestUsageSection(p)

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
        <AlertTriangle size={11} className="text-muted-foreground/80" />
        {!compact && <span className="text-[11px] font-medium">{statusLabel}</span>}
      </span>
    )
  }

  // Has data (ok, fetching with stale data, or error with stale data)
  const isStale = p.status === 'error'

  return (
    <span className="inline-flex items-center gap-1.5">
      <ProviderIcon provider={provider} />
      {mode === 'verbose' ? (
        <>
          {barsVisible && tightest && !compact ? (
            <MiniBar usedPct={clampUsedPercent(tightest.window.usedPercent)} display={display} />
          ) : null}
          <VerboseProviderUsage p={p} display={display} format={chipFormat} />
        </>
      ) : tightest ? (
        <WindowLabel
          w={tightest.window}
          label={tightest.label}
          display={display}
          format={chipFormat}
          showLabel={!compact}
        />
      ) : null}
      {isStale && <AlertTriangle size={11} className="text-muted-foreground/80" />}
    </span>
  )
}
