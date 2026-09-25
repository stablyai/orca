import React, { useEffect } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { SettingsSegmentedControl } from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { formatRateLimitWindowChipLabel, formatWindowLabel } from '@/lib/window-label-formatter'
import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../shared/rate-limit-types'
import {
  clampUsedPercent,
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { barColor, formatResetCountdown, getWindowSections, ProviderIcon } from './tooltip'
import { getProviderDisplayName } from './usage-error-copy'
import {
  formatPlanLabel,
  formatUsageUpdatedLabel,
  usageTextColorClass
} from './usage-roster-formatting'
import {
  buildUsageRosterEntries,
  getUsageRosterRowState,
  type UsageRosterRowState
} from './usage-roster-row-state'
import { useUsageRosterNow } from './use-usage-roster-now'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'

type ProviderId = ProviderRateLimits['provider']
export type UsageSection = { label: string; window: RateLimitWindow }

const EMPTY_INACTIVE_CODEX_ACCOUNTS: readonly InactiveAccountUsage[] = []

// Windows/buckets that actually carry data — absent limits arrive as null, but a
// partial/rehydrated provider can also carry an undefined window; both must be
// dropped so downstream consumers never dereference `window.usedPercent`.
function usedSections(p: ProviderRateLimits): UsageSection[] {
  return getWindowSections(p).filter(
    (s): s is UsageSection => s.window !== null && s.window !== undefined
  )
}

// Buckets (Gemini Flash/Pro) keep their model name; windows use their duration.
function shortLabel(
  p: ProviderRateLimits,
  section: UsageSection,
  useRemainingDuration = false
): string {
  if (p.buckets?.some((b) => b.name === section.label)) {
    return section.label
  }
  // fableWeekly shares the 7d window with weekly; label it distinctly so the two
  // don't both render as "wk".
  if (section.window === p.fableWeekly) {
    return 'Fable'
  }
  return useRemainingDuration
    ? formatRateLimitWindowChipLabel(section.window)
    : formatWindowLabel(section.window.windowMinutes)
}

export function getTightestUsageSection(p: ProviderRateLimits): UsageSection | null {
  const sections = usedSections(p)
  if (sections.length === 0) {
    return null
  }
  // Why: the footer promises one quiet summary per provider; choose urgency by
  // consumption even when the user displays the complementary “% left” value.
  const tightest = sections.reduce((current, candidate) =>
    clampUsedPercent(candidate.window.usedPercent) > clampUsedPercent(current.window.usedPercent)
      ? candidate
      : current
  )
  return { ...tightest, label: shortLabel(p, tightest, true) }
}

// The soonest-resetting window summarizes the agent's next reset in one line.
function soonestResetLabel(sections: UsageSection[], now: number): string | null {
  const resets = sections
    .map((s) => s.window.resetsAt)
    .filter((r): r is number => typeof r === 'number' && Number.isFinite(r))
  if (resets.length === 0) {
    return null
  }
  return formatResetCountdown(Math.min(...resets) - now)
}

function UsageMetric({
  section,
  label,
  display,
  showBar = true
}: {
  section: UsageSection
  label: string
  display: UsagePercentageDisplay
  showBar?: boolean
}): React.JSX.Element {
  const used = clampUsedPercent(section.window.usedPercent)
  const shown = getDisplayedUsagePercentage(section.window.usedPercent, display)

  return (
    <span data-usage-window={section.label} className="flex shrink-0 items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {showBar ? (
        <span data-usage-bar className="h-[5px] w-7 overflow-hidden rounded-full bg-muted">
          <span
            className={`block h-full rounded-full ${barColor(used)}`}
            style={{ width: `${shown}%` }}
          />
        </span>
      ) : null}
      <span className={`tabular-nums text-[11px] ${usageTextColorClass(used)}`}>{shown}%</span>
    </span>
  )
}

export function UsageRow({
  p,
  display,
  state,
  showSignInAction,
  now,
  mode = 'verbose',
  title,
  lastUpdatedAt
}: {
  p: ProviderRateLimits
  display: UsagePercentageDisplay
  state: UsageRosterRowState
  showSignInAction: boolean
  now: number
  mode?: StatusBarUsageMode
  title?: string | null
  lastUpdatedAt?: number | null
}): React.JSX.Element {
  const sections = usedSections(p)
  const hasUsage = sections.length > 0
  const name = title ?? getProviderDisplayName(p.provider)
  const plan = formatPlanLabel(p.planType)
  const reset = hasUsage ? soonestResetLabel(sections, now) : null
  const updated = lastUpdatedAt != null ? formatUsageUpdatedLabel(lastUpdatedAt, now) : null
  const meta = [updated, reset].filter(Boolean).join(' · ')
  const tightest = mode === 'compact' ? getTightestUsageSection(p) : null

  return (
    <div
      data-usage-mode={mode}
      data-usage-provider={p.provider}
      className="flex min-w-0 flex-1 flex-col gap-1"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
          <ProviderIcon provider={p.provider} />
        </span>
        <span className="min-w-0 shrink truncate text-[13px] font-medium text-foreground">
          {name}
          {plan ? <span className="font-normal text-muted-foreground"> · {plan}</span> : null}
        </span>
        {!hasUsage ? (
          <>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {state.statusLabel}
            </span>
            {showSignInAction ? (
              <span className="ml-auto shrink-0 rounded-md border border-border bg-secondary px-2.5 py-0.5 text-xs text-foreground">
                {translate('auto.components.status.bar.StatusBar.c35af53b73', 'Sign in')}
              </span>
            ) : null}
          </>
        ) : tightest ? (
          <span className="ml-auto">
            <UsageMetric
              section={tightest}
              label={tightest.label}
              display={display}
              showBar={false}
            />
          </span>
        ) : meta ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">{meta}</span>
        ) : null}
      </div>
      {hasUsage && mode === 'verbose' ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[30px]">
          {sections.map((section) => (
            <UsageMetric
              key={section.label}
              section={section}
              label={shortLabel(p, section)}
              display={display}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Consolidated "Usage" popover — one row per agent (icon · name · reset ·
 * per-window bars), plus read-only extra rows for inactive managed Codex
 * accounts. Deep per-agent actions route to Settings via the callbacks.
 */
export function UsageRosterPanel({
  providers,
  display,
  statusBarUsageMode,
  onStatusBarUsageModeChange,
  isRefreshing,
  onRefresh,
  onOpenProvider,
  onSignIn,
  canSignIn,
  onManageAccounts,
  onUsageDetails,
  renderRow,
  inactiveCodexAccounts = EMPTY_INACTIVE_CODEX_ACCOUNTS,
  codexAccountLabels,
  onFetchInactiveCodexAccounts
}: {
  providers: ProviderRateLimits[]
  display: UsagePercentageDisplay
  statusBarUsageMode: StatusBarUsageMode
  onStatusBarUsageModeChange: (mode: StatusBarUsageMode) => void
  isRefreshing: boolean
  onRefresh: () => void
  onOpenProvider: (provider: ProviderId) => void
  onSignIn: (provider: ProviderId) => void
  canSignIn: (provider: ProviderId) => boolean
  onManageAccounts: () => void
  onUsageDetails: () => void
  // Lets the host wrap a provider's row in a richer control (e.g. the
  // Claude/Codex account-switch drill-in submenu); return null to use the
  // default clickable row.
  renderRow?: (p: ProviderRateLimits, row: React.ReactNode) => React.ReactNode
  inactiveCodexAccounts?: readonly InactiveAccountUsage[]
  codexAccountLabels?: Readonly<Record<string, string>>
  onFetchInactiveCodexAccounts?: () => void
}): React.JSX.Element {
  useEffect(() => {
    onFetchInactiveCodexAccounts?.()
  }, [onFetchInactiveCodexAccounts])

  const entries = buildUsageRosterEntries(providers, inactiveCodexAccounts, codexAccountLabels)
  // Why: reset labels use the boundary-scheduled clock; Updated labels also need
  // a 60s tick because that scheduler is idle when every resetsAt is null.
  const now = useUsageRosterNow(
    entries.flatMap((entry) =>
      usedSections(entry.limits).map((section) => section.window.resetsAt)
    ),
    entries.map((entry) => entry.updatedAt)
  )

  return (
    <div className="w-[360px] text-xs">
      <div className="flex items-center justify-between px-3.5 pb-2 pt-3">
        <span className="text-[13px] font-semibold text-foreground">
          {translate('auto.components.status.bar.UsageRosterPanel.title', 'Usage')}
        </span>
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="text-[11px]">
            {translate('auto.components.status.bar.UsageRosterPanel.allAgents', 'all agents')}
          </span>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onRefresh()
              onFetchInactiveCodexAccounts?.()
            }}
            aria-label={translate(
              'auto.components.status.bar.StatusBar.3325d996cb',
              'Refresh rate limits'
            )}
            className="size-5 justify-center p-0"
          >
            <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
          </DropdownMenuItem>
        </div>
      </div>
      {/* Density picker lives at the top of the popover it controls (view-switcher
          pattern) so both modes are named and discoverable on first open. */}
      <div className="px-3.5 pb-2.5">
        <SettingsSegmentedControl<StatusBarUsageMode>
          value={statusBarUsageMode}
          onChange={onStatusBarUsageModeChange}
          ariaLabel={translate(
            'auto.components.status.bar.UsageRosterPanel.footerDetailAria',
            'Usage footer detail'
          )}
          size="sm"
          equalWidth
          options={[
            {
              value: 'verbose',
              label: translate('auto.components.status.bar.UsageRosterPanel.detailed', 'Detailed'),
              tooltip: translate(
                'auto.components.status.bar.UsageRosterPanel.detailedTooltip',
                'Full usage with bars, labels, and percentages'
              )
            },
            {
              value: 'compact',
              label: translate('auto.components.status.bar.UsageRosterPanel.compact', 'Compact'),
              tooltip: translate(
                'auto.components.status.bar.UsageRosterPanel.compactTooltip',
                'Condensed usage: only the tightest window'
              )
            }
          ]}
        />
      </div>
      <div className="border-t border-border/70" />
      {entries.map((entry) => {
        const p = entry.limits
        const state = getUsageRosterRowState(p, usedSections(p).length > 0)
        const showSignInAction =
          entry.interactive && state.kind === 'sign-in' && canSignIn(p.provider)
        const rowNode = (
          <UsageRow
            p={p}
            display={display}
            state={state}
            showSignInAction={showSignInAction}
            now={now}
            mode={statusBarUsageMode}
            title={entry.title}
            lastUpdatedAt={entry.updatedAt}
          />
        )
        if (!entry.interactive) {
          return (
            <div
              key={entry.key}
              data-inactive-codex-account={entry.accountId}
              className="w-full rounded-none px-3.5 py-2.5"
            >
              {rowNode}
            </div>
          )
        }
        if (showSignInAction) {
          return (
            <DropdownMenuItem
              key={entry.key}
              onSelect={() => onSignIn(p.provider)}
              className="w-full cursor-pointer rounded-none px-3.5 py-2.5"
            >
              {rowNode}
            </DropdownMenuItem>
          )
        }
        const custom = renderRow?.(p, rowNode)
        if (custom) {
          return <React.Fragment key={entry.key}>{custom}</React.Fragment>
        }
        return (
          <DropdownMenuItem
            key={entry.key}
            onSelect={() => onOpenProvider(p.provider)}
            className="w-full cursor-pointer rounded-none px-3.5 py-2.5"
          >
            {rowNode}
          </DropdownMenuItem>
        )
      })}
      <div className="border-t border-border/70" />
      <DropdownMenuItem
        onSelect={onUsageDetails}
        className="w-full cursor-pointer justify-between rounded-none px-3.5 py-2.5 text-[13px] text-foreground"
      >
        {translate(
          'auto.components.status.bar.UsageRosterPanel.usageDetails',
          'Usage details & history'
        )}
        <ChevronRight size={14} className="text-muted-foreground" />
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={onManageAccounts}
        className="w-full cursor-pointer justify-between rounded-none px-3.5 py-2.5 text-[13px] text-foreground"
      >
        {translate('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
        <ChevronRight size={14} className="text-muted-foreground" />
      </DropdownMenuItem>
    </div>
  )
}
