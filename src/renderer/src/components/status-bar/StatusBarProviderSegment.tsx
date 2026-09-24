import { AlertTriangle } from 'lucide-react'
import React from 'react'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { formatResetDuration } from '../../../../shared/rate-limit-reset-format'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { ProviderIcon, clampUsedPercent, getProviderUsageStatusLabel } from './tooltip'
import { getTightestUsageSection } from './UsageRosterPanel'
import { getTightestUsageSectionFromSections, type UsageSection } from './usage-section-selection'
import { formatRateLimitWindowChipLabel } from '@/lib/window-label-formatter'
import { formatUsagePercentageLabel } from './usage-percentage-label'
import { translate } from '@/i18n/i18n'
import { getAntigravityGroupShortLabel, sortAntigravityBuckets } from './antigravity-usage-format'

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
  showLabel = true
}: {
  w: RateLimitWindow
  label: string
  display: UsagePercentageDisplay
  showLabel?: boolean
}): React.JSX.Element {
  return (
    <span className="tabular-nums">
      {formatUsagePercentageLabel(w.usedPercent, display)}
      {showLabel ? ` ${label}` : ''}
    </span>
  )
}

function AntigravityCompactSummary({
  sections,
  display,
  now
}: {
  sections: UsageSection[]
  display: UsagePercentageDisplay
  now: number
}): React.JSX.Element {
  return (
    <>
      {sections.map((section, index) => {
        const reset = section.window.resetsAt
          ? formatResetDuration(section.window.resetsAt - now)
          : null
        return (
          <React.Fragment key={`${section.groupName ?? 'other'}:${section.label}`}>
            {index > 0 ? <span className="mx-1 text-muted-foreground">|</span> : null}
            <span className="inline-flex items-center gap-1 tabular-nums">
              <span className="text-muted-foreground">
                {getAntigravityGroupShortLabel(section.groupName)}
              </span>
              <span>
                {formatUsagePercentageLabel(section.window.usedPercent, display)}
                {reset ? ` ${reset}` : ''}
              </span>
            </span>
          </React.Fragment>
        )
      })}
    </>
  )
}

function getAntigravityCompactSections(p: ProviderRateLimits): UsageSection[] {
  const groups = new Map<string, UsageSection[]>()
  for (const bucket of p.buckets ?? []) {
    const key = bucket.groupName ?? ''
    const sections = groups.get(key) ?? []
    sections.push({ label: bucket.name, window: bucket, groupName: bucket.groupName })
    groups.set(key, sections)
  }
  return [...groups.values()]
    .map((sections) =>
      sortAntigravityBuckets(sections.map((section) => section.window)).map((window) =>
        sections.find((section) => section.window === window)!
      )
    )
    .map((sections) => getTightestUsageSectionFromSections(sections))
    .filter((section): section is UsageSection => section !== null)
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

function AntigravitySummary({
  p,
  display,
  now
}: {
  p: ProviderRateLimits
  display: UsagePercentageDisplay
  now: number
}): React.JSX.Element {
  const groups = new Map<string, NonNullable<ProviderRateLimits['buckets']>>()
  for (const bucket of p.buckets ?? []) {
    const key = bucket.groupName ?? ''
    const current = groups.get(key) ?? []
    current.push(bucket)
    groups.set(key, current)
  }
  return (
    <>
      {[...groups.entries()].map(([groupName, buckets], groupIndex) => (
        <React.Fragment key={groupName || 'other'}>
          {groupIndex > 0 ? <span className="mx-1 text-muted-foreground">|</span> : null}
          <span className="inline-flex items-center gap-1 tabular-nums">
            <span className="text-muted-foreground">
              {getAntigravityGroupShortLabel(groupName)}
            </span>
            {sortAntigravityBuckets(buckets).map((bucket, index) => (
              <React.Fragment key={bucket.id ?? `${bucket.groupName}:${bucket.windowMinutes}`}>
                {index > 0 ? <span className="text-muted-foreground">·</span> : null}
                <span>
                  {formatUsagePercentageLabel(bucket.usedPercent, display)}
                  {bucket.resetsAt ? ` ${formatResetDuration(bucket.resetsAt - now)}` : ''}
                </span>
              </React.Fragment>
            ))}
          </span>
        </React.Fragment>
      ))}
    </>
  )
}

function VerboseProviderUsage({
  p,
  display,
  now
}: {
  p: ProviderRateLimits
  display: UsagePercentageDisplay
  now: number
}): React.JSX.Element {
  if (p.provider === 'antigravity' && p.buckets?.length) {
    return <AntigravitySummary p={p} display={display} now={now} />
  }
  if (p.buckets && p.buckets.length > 0) {
    const visibleBuckets =
      p.provider === 'antigravity'
        ? p.buckets
        : p.buckets.filter((bucket) => STATUS_BAR_BUCKET_NAMES.has(bucket.name))
    return (
      <>
        {visibleBuckets.map((bucket, index) => (
          <React.Fragment key={bucket.name}>
            {index > 0 ? <span className="text-muted-foreground">·</span> : null}
            <span className="tabular-nums">
              {bucket.name} {formatUsagePercentageLabel(bucket.usedPercent, display)}
            </span>
          </React.Fragment>
        ))}
        {visibleBuckets.length === 0 && p.session ? (
          <WindowLabel
            w={p.session}
            label={formatRateLimitWindowChipLabel(p.session)}
            display={display}
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
          label: formatRateLimitWindowChipLabel(p.session)
        }
      : null,
    p.weekly
      ? {
          key: 'weekly',
          window: p.weekly,
          label: formatRateLimitWindowChipLabel(p.weekly)
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
          label: formatRateLimitWindowChipLabel(p.monthly)
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
          <WindowLabel w={window.window} label={window.label} display={display} />
        </React.Fragment>
      ))}
    </>
  )
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
  const now = useResetCountdownClock((p?.buckets ?? []).map((bucket) => bucket.resetsAt))

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
          {tightest && !compact ? (
            <MiniBar usedPct={clampUsedPercent(tightest.window.usedPercent)} display={display} />
          ) : null}
          <VerboseProviderUsage p={p} display={display} now={now} />
        </>
      ) : p.provider === 'antigravity' ? (
        <AntigravityCompactSummary
          sections={getAntigravityCompactSections(p)}
          display={display}
          now={now}
        />
      ) : tightest ? (
        <WindowLabel
          w={tightest.window}
          label={tightest.label}
          display={display}
          showLabel={!compact}
        />
      ) : null}
      {isStale && <AlertTriangle size={11} className="text-muted-foreground/80" />}
    </span>
  )
}
