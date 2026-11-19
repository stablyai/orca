import { useAppStore } from '@/store/index'
import { resolveStatusBarUsageTemplate } from '../../../../../shared/status-bar/status-bar-usage-format'
import { buildUsageFormatValues, renderUsageFormatTemplate } from './usage-format-template'
import { AlertTriangle } from 'lucide-react'
import React from 'react'
import { useSectionOnScreen } from '../../right-sidebar/source-control/panel/section-viewport-presence'
import type {
  OwnerNotSetUpPlaceholder,
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  type UsagePercentageDisplay,
  clampUsedPercent
} from '../../../../../shared/agent-usage/display/usage-percentage-display'
import type { StatusBarUsageMode } from '../../../../../shared/status-bar/status-bar-usage-mode'
import { formatCurrencyAmount } from '../../../../../shared/agent-usage/display/currency-format'
import { formatCreditCount } from '../../../../../shared/agent-usage/display/credit-count-format'
import { ProviderIcon } from './provider-usage-panel'
import { USAGE_WARNING_PERCENT } from './usage-health-tone'
import { UsageBar } from './usage-meter'
import { getOwnerNotSetUpLabelParts } from '../../../../../shared/agent-usage/status-copy/owner-not-set-up-copy'
import {
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel,
  isClaudeUsageWaitingForClaude
} from '../../../../../shared/agent-usage/status-copy/usage-error-copy'
import { getTightestUsageSection, getUsageHeadlineSection } from './usage-headline-sections'
import { getProviderDisplayName } from '../../../../../shared/agent-usage/display/usage-provider-windows'
import { formatBareUsagePercentage, formatUsagePercentageLabel } from './usage-percentage-label'
import { translate } from '@/i18n/i18n'
import { useTranslate, useIntlLocale, type Translate } from '@/i18n/use-translate'
import { getStatusBarUsageSections } from '../composition/status-bar-usage-sections'
import { GroupedPoolUsage } from './usage-grouped-pools'
import { formatStatusBarSectionLabel } from './usage-pool-label'
import { isGroupedUsagePool } from '../../../../../shared/agent-usage/display/grouped-usage-pool'
import { useResetCountdownClock } from '@/components/status-bar/usage/useResetCountdownClock'
import { useNow } from '@/lib/window-activity/use-now'

const CALM_STALE_USAGE_MAX_AGE_MS = 30 * 60_000

function MiniBar({
  usedPct,
  display
}: {
  usedPct: number
  display: UsagePercentageDisplay
}): React.JSX.Element {
  // Why plain: usage is colored only inside a provider's details card, never in the status bar.
  return <UsageBar usedPercent={usedPct} display={display} className="h-[6px] w-[48px] shrink-0" />
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
  const t = useTranslate()
  return (
    <span className="tabular-nums">
      {showLabel && labelFirst ? `${label} ` : ''}
      {formatBareUsagePercentage(w.usedPercent, display, t)}
      {showLabel && !labelFirst ? ` ${label}` : ''}
    </span>
  )
}

// Share badge markup and data detection between the roster trigger and provider details.
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

// Why only the host name truncates: the phrase around it must stay readable in every locale.
function OwnerNotSetUpLabel({
  placeholder
}: {
  placeholder: OwnerNotSetUpPlaceholder
}): React.JSX.Element {
  const t = useTranslate()
  const { before, host, after } = getOwnerNotSetUpLabelParts(placeholder, t)
  return (
    <span className="text-[11px] font-medium">
      {before}
      {host ? (
        <span data-owner-host className="inline-block max-w-28 truncate align-bottom">
          {host}
        </span>
      ) : null}
      {after}
    </span>
  )
}

/**
 * A provider at 80%+ used keeps its chip when the status bar runs out of room, whatever % display
 * the user chose. Why 80: the status bar's original threshold; it drives collapsing, not color.
 */
export function isUsageUrgent(p: ProviderRateLimits): boolean {
  const tightest = getTightestUsageSection(p, undefined, 'all')
  return tightest !== null && clampUsedPercent(tightest.window.usedPercent) >= USAGE_WARNING_PERCENT
}

/** Stands in for the chips a narrow bar leaves out; its tooltip names them and the popover lists them. */
export function UsageOverflowChip({
  hidden,
  providerCount,
  display,
  restartPending = false
}: {
  hidden: readonly ProviderRateLimits[]
  providerCount: number
  display: UsagePercentageDisplay
  /** A hidden chip has a pending account restart: fill amber like its badge would be. */
  restartPending?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const tone = restartPending ? 'restart' : 'normal'
  const names = hidden
    .map((p) => {
      const tightest = getTightestUsageSection(p, t, 'all')
      const name = getProviderDisplayName(p.provider)
      return tightest
        ? `${name} ${formatUsagePercentageLabel(tightest.window.usedPercent, display, t)}`
        : name
    })
    .join(', ')
  return (
    <span
      data-tone={tone}
      title={t('auto.components.status.bar.StatusBar.hiddenUsageProviders', 'Also: {{value0}}', {
        value0: names
      })}
      className="inline-grid h-4 items-center justify-items-center rounded-full border border-border px-1.5 text-[11px] font-medium tabular-nums text-foreground data-[tone=restart]:border-transparent data-[tone=restart]:bg-status-warning data-[tone=restart]:text-status-warning-on-solid"
    >
      {/* Why: reserve the widest count so the measured width doesn't depend on how many are hidden. */}
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
    case 'muse':
      return 'S'
    case 'codex':
      return 'X'
  }
}

// Treat 99.5% as capped to tolerate rounding before revealing spendable overage.
const CAP_THRESHOLD_PERCENT = 99.5

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

function formatCompactExtraUsage(
  balance: ProviderRateLimits['extraUsage'],
  t: Translate = translate
): string {
  if (!balance) {
    return ''
  }
  if (balance.unit === 'credits') {
    return balance.unlimited
      ? t('auto.components.status.bar.StatusBar.4025a6f62f', 'Unlimited')
      : t('auto.components.status.bar.StatusBar.a95969101f', '{{value0}} credits', {
          value0: formatCreditCount(balance.balance)
        })
  }
  return balance.balance === null
    ? ''
    : t('auto.components.status.bar.StatusBar.4fba7dc1e7', '{{value0}} bal', {
        value0: formatCurrencyAmount(balance.balance, balance.currencyCode)
      })
}

function CustomUsageText({
  template,
  limits,
  display,
  now
}: {
  template: string
  limits: ProviderRateLimits
  display: UsagePercentageDisplay
  now: number
}): React.JSX.Element {
  const locale = useIntlLocale()
  return (
    <span className="whitespace-pre tabular-nums">
      {renderUsageFormatTemplate(
        template,
        buildUsageFormatValues(limits, { display, now, locale })
      )}
    </span>
  )
}

type ProviderSegmentProps = {
  p: ProviderRateLimits | null
  /** Narrow bar: one percentage per window, no mini bar or status text. */
  compact?: boolean
  display: UsagePercentageDisplay
  mode?: StatusBarUsageMode
  countdownActive?: boolean
}

/** A chip in the clipping status bar row: clipped chips stop their countdown wakes. */
export function ClippedRowProviderSegment(props: ProviderSegmentProps): React.JSX.Element {
  const [ref, onScreen] = useSectionOnScreen('viewport')
  return (
    <span ref={ref} className="inline-flex items-center">
      <ProviderSegment {...props} countdownActive={onScreen} />
    </span>
  )
}

export function ProviderSegment({
  p,
  compact = false,
  display,
  mode = 'verbose',
  countdownActive = true
}: ProviderSegmentProps): React.JSX.Element {
  const t = useTranslate()
  const provider = p?.provider ?? 'claude'
  const usageFormat = useAppStore((state) => state.statusBarUsageFormat)
  const template = resolveStatusBarUsageTemplate(usageFormat, provider)
  const statusLabel = p ? getProviderUsageStatusLabel(p, t) : ''
  // Why: not a problem; Claude updates its own login the next time it runs.
  const calm = p ? isClaudeUsageWaitingForClaude(p) : false
  const calmClock = useNow(60_000, calm && p?.status === 'error')
  const tightest = p
    ? mode === 'compact'
      ? getUsageHeadlineSection(p, t, 'all')
      : getTightestUsageSection(p, t, 'all')
    : null
  const sections = getStatusBarUsageSections(p, mode, t)
  const groupedBuckets = sections.map((section) => section.window).filter(isGroupedUsagePool)
  const showLabels = mode === 'verbose' || !compact
  // Why: gate only the clock, never the label, so visibility can't change width and re-trigger itself.
  const now = useResetCountdownClock(
    !countdownActive
      ? []
      : template && p
        ? [p.session?.resetsAt, p.weekly?.resetsAt, p.fableWeekly?.resetsAt, p.monthly?.resetsAt]
        : showLabels
          ? groupedBuckets
              .filter((bucket) => clampUsedPercent(bucket.usedPercent) >= USAGE_WARNING_PERCENT)
              .map((bucket) => bucket.resetsAt)
          : []
  )

  // Why static: unfocused windows never poll, so a pending chip's pulse would redraw the compositor indefinitely.
  if (!p || p.status === 'idle' || (p.status === 'fetching' && !tightest)) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <span>···</span>
      </span>
    )
  }

  if (p.status === 'unavailable') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground/50">
        <ProviderIcon provider={provider} /> --
      </span>
    )
  }

  if (p.usageMetadata?.ownerNotSetUp) {
    return (
      <span
        className="inline-flex items-center gap-1 text-muted-foreground"
        title={getProviderUsageErrorMessage(p, t)}
      >
        <ProviderIcon provider={provider} />
        {/* Why "--" when compact: an icon alone would read as a healthy chip. */}
        {compact ? '--' : <OwnerNotSetUpLabel placeholder={p.usageMetadata.ownerNotSetUp} />}
      </span>
    )
  }

  if (p.status === 'error' && !tightest) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        {!calm && <AlertTriangle size={11} className="text-muted-foreground/80" />}
        {!compact && <span className="text-[11px] font-medium">{statusLabel}</span>}
      </span>
    )
  }

  // Why: calm is honest only while the kept bars are recent; old ones still deserve the warning.
  const isStale =
    p.status === 'error' && (!calm || calmClock - p.updatedAt > CALM_STALE_USAGE_MAX_AGE_MS)
  const showBalance = isExtraUsageActive(p)
  const showGroupedPools =
    mode === 'verbose' && groupedBuckets.length > 0 && groupedBuckets.length === sections.length

  return (
    <span className="inline-flex items-center gap-1.5">
      <ProviderIcon provider={provider} />
      {!template && mode === 'verbose' && tightest && !compact ? (
        <MiniBar usedPct={clampUsedPercent(tightest.window.usedPercent)} display={display} />
      ) : null}
      {template ? (
        <CustomUsageText template={template} limits={p} display={display} now={now} />
      ) : showGroupedPools ? (
        <GroupedPoolUsage
          visibleBuckets={groupedBuckets}
          allBuckets={p.buckets ?? []}
          display={display}
          now={now}
        />
      ) : (
        sections.map((section, index) => (
          <React.Fragment key={section.key}>
            {index > 0 ? <span className="text-muted-foreground">·</span> : null}
            <WindowLabel
              w={section.window}
              label={formatStatusBarSectionLabel(p, section, now, t)}
              display={display}
              showLabel={showLabels}
              labelFirst={section.labelFirst}
            />
          </React.Fragment>
        ))
      )}
      {!template && showBalance && p.extraUsage ? (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="tabular-nums">{formatCompactExtraUsage(p.extraUsage, t)}</span>
        </>
      ) : null}
      {isStale && <AlertTriangle size={11} className="text-muted-foreground/80" />}
    </span>
  )
}
