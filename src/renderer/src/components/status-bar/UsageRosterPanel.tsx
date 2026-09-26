import React from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { SettingsSegmentedControl } from '@/components/settings/SettingsFormControls'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { translate } from '@/i18n/i18n'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { getUsageRosterRowState } from './usage-roster-row-state'
import { UsageRow, usedSections } from './UsageRow'
import { entryRateLimits, providerUsageEntry, type AccountUsageEntry } from './account-usage-entry'

export { UsageRow, getTightestUsageSection } from './UsageRow'
type ProviderId = ProviderRateLimits['provider']
const EMPTY_PROVIDERS: ProviderRateLimits[] = []

// Shared account roster; explicit switching stays in the detail menus.
export function UsageRosterPanel({
  providers = EMPTY_PROVIDERS,
  entries = providers.map(providerUsageEntry),
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
  providers?: ProviderRateLimits[]
  entries?: AccountUsageEntry[]
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
  renderRow?: (
    p: ProviderRateLimits,
    row: React.ReactNode,
    entry: AccountUsageEntry
  ) => React.ReactNode
}): React.JSX.Element {
  // Why: one boundary-scheduled clock keeps every open row current without per-provider timers.
  const now = useResetCountdownClock(
    entries.flatMap((entry) =>
      usedSections(entryRateLimits(entry)).map((section) => section.window.resetsAt)
    )
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
      <div className="max-h-[360px] overflow-y-auto scrollbar-sleek">
        {entries.map((entry) => {
          const p = entryRateLimits(entry)
          const state = getUsageRosterRowState(p, usedSections(p).length > 0)
          const showSignInAction = state.kind === 'sign-in' && canSignIn(p.provider)
          const rowNode = (
            <UsageRow
              p={p}
              accountLabel={entry.label}
              selected={entry.selected && entry.label !== null}
              display={display}
              state={state}
              showSignInAction={showSignInAction}
              now={now}
              mode={statusBarUsageMode}
            />
          )
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
          const custom = renderRow?.(p, rowNode, entry)
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
      </div>
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
