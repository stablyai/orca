import React from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { SettingsSegmentedControl } from '@/components/settings/SettingsFormControls'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { translate } from '@/i18n/i18n'
import { formatRateLimitWindowChipLabel, formatWindowLabel } from '@/lib/window-label-formatter'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  clampUsedPercent,
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { barColor, formatResetCountdown, getWindowSections, ProviderIcon } from './tooltip'
import { getProviderDisplayName } from './usage-error-copy'
import { formatPlanLabel, usageTextColorClass } from './usage-roster-formatting'
import { getUsageRosterRowState, type UsageRosterRowState } from './usage-roster-row-state'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'

type ProviderId = ProviderRateLimits['provider']
export type UsageSection = { label: string; window: RateLimitWindow }

// Windows/buckets that actually carry data — the null ones are absent limits.
function usedSections(p: ProviderRateLimits): UsageSection[] {
  return getWindowSections(p).filter((s): s is UsageSection => s.window !== null)
}

function providerMaxUsed(sections: UsageSection[]): number {
  return sections.length > 0
    ? Math.max(...sections.map((s) => clampUsedPercent(s.window.usedPercent)))
    : 0
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

// Presentational row: a compact header (icon · name · plan · reset) with
// the per-window metrics beneath, so the reset stays visible and multi-window
// agents stay short. The wrapper supplies padding + interaction (drill-in
// submenu or plain clickable row).
export function UsageRow({
  p,
  display,
  state,
  showSignInAction,
  now
}: {
  p: ProviderRateLimits
  display: UsagePercentageDisplay
  state: UsageRosterRowState
  showSignInAction: boolean
  now: number
}): React.JSX.Element {
  const sections = usedSections(p)
  const hasUsage = sections.length > 0
  const name = getProviderDisplayName(p.provider)
  const plan = formatPlanLabel(p.planType)
  const reset = hasUsage ? soonestResetLabel(sections, now) : null

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
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
        ) : reset ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">{reset}</span>
        ) : null}
      </div>
      {hasUsage ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[30px]">
          {sections.map((s) => {
            const used = clampUsedPercent(s.window.usedPercent)
            const shown = getDisplayedUsagePercentage(s.window.usedPercent, display)
            return (
              <span key={s.label} className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">{shortLabel(p, s)}</span>
                <span className="h-[5px] w-7 overflow-hidden rounded-full bg-muted">
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
      ) : null}
    </div>
  )
}

/**
 * Consolidated "Usage" popover — one row per agent (icon · name · reset ·
 * per-window bars), opened from the status-bar roster pill. Deep per-agent
 * actions route to Settings via the callbacks.
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
  renderRow
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
}): React.JSX.Element {
  // Why: one boundary-scheduled clock keeps every open row current without per-provider timers.
  const now = useResetCountdownClock(
    providers.flatMap((provider) =>
      usedSections(provider).map((section) => section.window.resetsAt)
    )
  )
  // Worst-first so the agent nearest a limit sits on top.
  const sorted = [...providers].sort(
    (a, b) => providerMaxUsed(usedSections(b)) - providerMaxUsed(usedSections(a))
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
      {sorted.map((p) => {
        const state = getUsageRosterRowState(p, usedSections(p).length > 0)
        const showSignInAction = state.kind === 'sign-in' && canSignIn(p.provider)
        const rowNode = (
          <UsageRow
            p={p}
            display={display}
            state={state}
            showSignInAction={showSignInAction}
            now={now}
          />
        )
        if (showSignInAction) {
          return (
            <DropdownMenuItem
              key={p.provider}
              onSelect={() => onSignIn(p.provider)}
              className="w-full cursor-pointer rounded-none px-3.5 py-2.5"
            >
              {rowNode}
            </DropdownMenuItem>
          )
        }
        const custom = renderRow?.(p, rowNode)
        if (custom) {
          return <React.Fragment key={p.provider}>{custom}</React.Fragment>
        }
        return (
          <DropdownMenuItem
            key={p.provider}
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
