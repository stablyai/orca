import React from 'react'
import { RefreshCw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { UsageRosterPanel } from './usage/UsageRosterPanel'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './composition/status-bar-context-menu-policy'
import { StatusBarUsageEmptyCta } from './usage/StatusBarUsageEmptyCta'
import { StatusBarUsageChangeNotices } from './usage/StatusBarUsageChangeNotices'
import { ClaudeSwitcherMenu } from './accounts/ClaudeSwitcherMenu'
import { CodexSwitcherMenu } from './accounts/CodexSwitcherMenu'
import { ProviderDetailsMenu } from './usage/ProviderDetailsMenu'
import { AntigravityUsageMenu } from './usage/AntigravityUsageMenu'
import {
  ClippedRowProviderSegment,
  ProviderSegment,
  UsageOverflowChip,
  isUsageUrgent
} from './usage/StatusBarProviderSegment'
import {
  USAGE_ROW_LEVELS,
  chooseUsageRowLayout,
  type UsageChipFacts,
  type UsageRowLayout
} from './composition/status-bar-usage-collapse'
import { useUsageRowWidths } from './composition/use-usage-row-widths'
import { UsageUnitLabel, usageChipShowsPercentage } from './usage/usage-unit-label'
import type { useStatusBarController } from './composition/use-status-bar-controller'
import { isOwnerNotSetUpPlaceholder } from './usage/owner-usage-rate-limits'
import { getAccountOwnerKey } from './accounts/owner-account-rows'
import {
  CodexRestartBadge,
  codexRestartBadgeLabel,
  useCodexStaleSessionCount
} from './accounts/CodexRestartBadge'

type StatusBarController = NonNullable<ReturnType<typeof useStatusBarController>>

/** The status bar's usage chips, their roster popover and the refresh button. */
export function StatusBarUsageArea({
  controller
}: {
  controller: StatusBarController
}): React.JSX.Element {
  const t = useTranslate()
  const [usageAreaRef, usageWidths] = useUsageRowWidths()
  const codexStaleSessionCount = useCodexStaleSessionCount()
  const {
    antigravityAccounts,
    anyFetching,
    anyVisible,
    canSignInFromUsageRow,
    handleManageAccounts,
    handleOpenProviderAccounts,
    handleRefresh,
    handleUsageDetails,
    handleUsageMenuOpenChange,
    hasVisibleUsageMeters,
    isEmptyUsageState,
    isRefreshing,
    ownerUsage,
    remoteOwner,
    rosterProviders,
    setStatusBarUsageMode,
    showEmptyUsageCta,
    statusBarUsageMode,
    usageMenuFocusHandoff,
    usageMenuOpen,
    usagePercentageDisplay
  } = controller
  const levelMode = (level: number) =>
    USAGE_ROW_LEVELS[level]?.tightestOnly ? 'compact' : statusBarUsageMode
  const chipFacts: UsageChipFacts[] = rosterProviders.map((p) => ({
    provider: p.provider,
    urgent: isUsageUrgent(p) || (p.provider === 'codex' && codexStaleSessionCount > 0),
    percentage: [
      usageChipShowsPercentage(p, levelMode(0), t),
      usageChipShowsPercentage(p, levelMode(1), t),
      usageChipShowsPercentage(p, levelMode(2), t)
    ]
  }))
  const usageLayout: UsageRowLayout = usageWidths
    ? chooseUsageRowLayout(usageWidths, chipFacts)
    : { level: 0, collapsed: [] }
  const usageMode = levelMode(usageLayout.level)
  const usageCompact = USAGE_ROW_LEVELS[usageLayout.level]?.compact ?? false
  const shownProviders = rosterProviders.filter((p) => !usageLayout.collapsed.includes(p.provider))
  const hiddenProviders = rosterProviders.filter((p) => usageLayout.collapsed.includes(p.provider))
  const showUnitLabel = shownProviders.some((p) => usageChipShowsPercentage(p, usageMode, t))
  const usageLabel = t('auto.components.status.bar.UsageRosterPanel.title', 'Usage')
  // Why: announce restarts only when this menu has a Codex row that opens the restart action;
  // a hidden Codex status item or a not-set-up placeholder leaves nothing to act on here.
  const announcedRestartCount = rosterProviders.some(
    (p) => p.provider === 'codex' && !isOwnerNotSetUpPlaceholder(p)
  )
    ? codexStaleSessionCount
    : 0

  // Why: usage gives way first, but keeps enough width to stay clickable; its popover holds
  // every provider. Its form is chosen from widths measured off-layout (see useUsageRowWidths).
  return (
    <div
      ref={usageAreaRef}
      data-usage-area=""
      className={cn(
        'relative flex flex-1 items-center overflow-clip [overflow-clip-margin:3px]',
        hasVisibleUsageMeters ? 'min-w-16' : 'min-w-0'
      )}
    >
      <div data-usage-row="" className="flex shrink-0 items-center gap-3">
        {isEmptyUsageState ? (
          showEmptyUsageCta ? (
            <StatusBarUsageEmptyCta remoteOwner={remoteOwner} />
          ) : null
        ) : hasVisibleUsageMeters ? (
          <StatusBarUsageChangeNotices hasVisibleUsageMeters={hasVisibleUsageMeters}>
            <DropdownMenu
              open={usageMenuOpen}
              onOpenChange={handleUsageMenuOpenChange}
              modal={false}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-usage-trigger=""
                  className="inline-flex items-center gap-3 rounded px-1 py-0.5 hover:bg-accent/70"
                  aria-label={
                    announcedRestartCount > 0
                      ? `${usageLabel}. ${codexRestartBadgeLabel(announcedRestartCount, t)}`
                      : usageLabel
                  }
                >
                  {showUnitLabel ? <UsageUnitLabel display={usagePercentageDisplay} /> : null}
                  {shownProviders.map((p) => (
                    <span key={p.provider} className="inline-flex items-center gap-1">
                      <ClippedRowProviderSegment
                        p={p}
                        compact={usageCompact}
                        display={usagePercentageDisplay}
                        mode={usageMode}
                      />
                      {p.provider === 'codex' ? (
                        <CodexRestartBadge count={codexStaleSessionCount} />
                      ) : null}
                    </span>
                  ))}
                  {hiddenProviders.length > 0 ? (
                    <UsageOverflowChip
                      hidden={hiddenProviders}
                      providerCount={rosterProviders.length}
                      display={usagePercentageDisplay}
                      restartPending={
                        codexStaleSessionCount > 0 &&
                        hiddenProviders.some((p) => p.provider === 'codex')
                      }
                    />
                  ) : null}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
                side="top"
                align="start"
                sideOffset={8}
                // Reserve footer height so the popover and drill-in submenus stay above the status bar.
                collisionPadding={{ top: 8, bottom: 32, left: 8, right: 8 }}
                variant="picker"
                className="w-[440px] max-w-[calc(100vw-1rem)]"
                onPointerDownOutside={usageMenuFocusHandoff.onPointerDownOutside}
                onCloseAutoFocus={usageMenuFocusHandoff.onCloseAutoFocus}
              >
                <UsageRosterPanel
                  providers={rosterProviders}
                  display={usagePercentageDisplay}
                  statusBarUsageMode={statusBarUsageMode}
                  onStatusBarUsageModeChange={setStatusBarUsageMode}
                  isRefreshing={isRefreshing || anyFetching}
                  onRefresh={handleRefresh}
                  onOpenProvider={handleOpenProviderAccounts}
                  onSignIn={handleOpenProviderAccounts}
                  canSignIn={canSignInFromUsageRow}
                  onManageAccounts={handleManageAccounts}
                  onUsageDetails={handleUsageDetails}
                  renderRow={(p, rowNode) => {
                    // Why: a placeholder has nothing to drill into; its row opens the host's accounts.
                    if (isOwnerNotSetUpPlaceholder(p)) {
                      return null
                    }
                    // Claude/Codex detail panels also expose account switching and runtime controls.
                    if (p.provider === 'claude') {
                      return (
                        <ClaudeSwitcherMenu
                          claude={p}
                          ownerUsage={ownerUsage}
                          asSubmenu
                          triggerContent={rowNode}
                        />
                      )
                    }
                    if (p.provider === 'antigravity') {
                      return (
                        <AntigravityUsageMenu
                          antigravity={p}
                          accounts={antigravityAccounts}
                          triggerContent={rowNode}
                          onManageAccounts={() => handleOpenProviderAccounts('antigravity')}
                        />
                      )
                    }
                    if (p.provider === 'codex') {
                      return (
                        <CodexSwitcherMenu
                          key={getAccountOwnerKey(ownerUsage.owner)}
                          codex={p}
                          ownerUsage={ownerUsage}
                          asSubmenu
                          triggerContent={rowNode}
                        />
                      )
                    }
                    return (
                      <ProviderDetailsMenu
                        provider={p}
                        asSubmenu
                        triggerContent={rowNode}
                        ariaLabel={t(
                          'auto.components.status.bar.UsageRosterPanel.openDetails',
                          'Open usage details'
                        )}
                      />
                    )
                  }}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </StatusBarUsageChangeNotices>
        ) : null}
        {anyVisible && !isEmptyUsageState && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-usage-refresh=""
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                aria-label={t(
                  'auto.components.status.bar.StatusBar.3325d996cb',
                  'Refresh rate limits'
                )}
              >
                <RefreshCw
                  size={11}
                  className={isRefreshing || anyFetching ? 'animate-spin' : ''}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {t('auto.components.status.bar.StatusBar.c8857b40f7', 'Refresh usage data')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {hasVisibleUsageMeters ? (
        // Why: every chip in every form, never shown and never changed by the layout choice.
        <div
          aria-hidden="true"
          inert
          className="pointer-events-none invisible absolute left-0 top-0 flex w-max items-center"
        >
          <span data-measure-unit="" className="inline-flex">
            <UsageUnitLabel display={usagePercentageDisplay} />
          </span>
          {rosterProviders.flatMap((p) =>
            USAGE_ROW_LEVELS.map((level, index) => (
              <span
                key={`${p.provider}-${index}`}
                data-measure-chip={p.provider}
                data-measure-level={index}
                className="inline-flex items-center gap-1"
              >
                <ProviderSegment
                  p={p}
                  compact={level.compact}
                  display={usagePercentageDisplay}
                  mode={levelMode(index)}
                  countdownActive={false}
                />
                {/* Why: the shown Codex chip carries its restart badge, so its measured width must too. */}
                {p.provider === 'codex' ? (
                  <CodexRestartBadge count={codexStaleSessionCount} />
                ) : null}
              </span>
            ))
          )}
          <span data-measure-more="" className="inline-flex">
            <UsageOverflowChip
              hidden={[]}
              providerCount={rosterProviders.length}
              display={usagePercentageDisplay}
            />
          </span>
        </div>
      ) : null}
    </div>
  )
}
