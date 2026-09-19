import { PanelsTopLeft, RefreshCw } from 'lucide-react'
import React from 'react'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { getProviderDisplayName } from './tooltip'
import { UsageRosterPanel } from './UsageRosterPanel'
import { getUsageProviderAccountsSectionId } from './usage-provider-settings-target'
import {
  STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS,
  shouldOpenStatusBarContextMenu
} from './status-bar-context-menu-policy'
import { StatusBarUsageEmptyCta } from './StatusBarUsageEmptyCta'
import { UsagePercentageDisplayChangeNotice } from './UsagePercentageDisplayChangeNotice'
import { UpdateStatusSegment } from './UpdateStatusSegment'
import { SkillUpdateStatusSegment } from './SkillUpdateStatusSegment'
import { CaffeinateStatusSegment } from './CaffeinateStatusSegment'
import { RemoteServerUpdateStatusSegment } from './RemoteServerUpdateStatusSegment'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { FloatingTerminalIconContextMenu } from '@/components/floating-terminal/FloatingTerminalIconContextMenu'
import { ClaudeSwitcherMenu } from './ClaudeSwitcherMenu'
import { CodexSwitcherMenu } from './CodexSwitcherMenu'
import { ProviderDetailsMenu, CLOSE_ALL_CONTEXT_MENUS_EVENT } from './ProviderDetailsMenu'
import { ProviderLetterBadge, ProviderSegment } from './StatusBarProviderSegment'
import { useStatusBarController } from './use-status-bar-controller'
import { StatusBarVisibilityMenu } from './StatusBarVisibilityMenu'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'

const PetStatusSegment = lazyWithRetry(() =>
  import('./PetStatusSegment').then((module) => ({ default: module.PetStatusSegment }))
)
const ResourceUsageStatusSegment = lazyWithRetry(() =>
  import('./ResourceUsageStatusSegment').then((module) => ({
    default: module.ResourceUsageStatusSegment
  }))
)
const PortsStatusSegment = lazyWithRetry(() =>
  import('./PortsStatusSegment').then((module) => ({ default: module.PortsStatusSegment }))
)
const SshStatusSegment = lazyWithRetry(() =>
  import('./SshStatusSegment').then((module) => ({ default: module.SshStatusSegment }))
)

export type StatusBarProps = {
  floatingTerminalOpen: boolean
}

export function StatusBarSurface({
  floatingTerminalOpen
}: StatusBarProps): React.JSX.Element | null {
  const controller = useStatusBarController(floatingTerminalOpen)
  if (!controller) {
    return null
  }
  const {
    anyFetching,
    anyVisible,
    compact,
    containerRefCallback,
    floatingTerminalActionLabel,
    floatingTerminalShortcut,
    handleManageAccounts,
    handleOpenProviderAccounts,
    handleRefresh,
    handleUsageDetails,
    handleUsageMenuOpenChange,
    hasVisibleUsageMeters,
    iconOnly,
    isEmptyUsageState,
    isRefreshing,
    petEnabled,
    rosterProviders,
    setMenuOpen,
    setMenuPoint,
    setStatusBarUsageMode,
    showEmptyUsageCta,
    showFloatingTerminalToggle,
    showFloatingWorkspaceAttentionDot,
    showPorts,
    showResourceUsage,
    showSsh,
    statusBarUsageMode,
    usageMenuFocusHandoff,
    usageMenuOpen,
    usagePercentageDisplay
  } = controller

  return (
    <div
      ref={containerRefCallback}
      className="flex items-center h-6 min-h-[24px] px-3 gap-4 border-t border-border bg-[var(--bg-titlebar,var(--card))] text-xs select-none shrink-0 relative"
      onContextMenuCapture={(event) => {
        if (!shouldOpenStatusBarContextMenu(event.target)) {
          return
        }
        // Why: mirror the app-wide right-click pattern — close peer menus, then anchor a hidden trigger at the cursor so re-clicks reposition.
        event.preventDefault()
        window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
        const bounds = event.currentTarget.getBoundingClientRect()
        setMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        setMenuOpen(true)
      }}
    >
      <div className="flex items-center gap-3">
        {isEmptyUsageState ? (
          showEmptyUsageCta ? (
            <StatusBarUsageEmptyCta />
          ) : null
        ) : hasVisibleUsageMeters ? (
          // Consolidated roster pill → opens the all-agents Usage popover (mock parity).
          <UsagePercentageDisplayChangeNotice hasVisibleUsageMeters={hasVisibleUsageMeters}>
            <DropdownMenu
              open={usageMenuOpen}
              onOpenChange={handleUsageMenuOpenChange}
              modal={false}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-3 rounded px-1 py-0.5 hover:bg-accent/70"
                  aria-label={translate(
                    'auto.components.status.bar.UsageRosterPanel.title',
                    'Usage'
                  )}
                >
                  {rosterProviders.map((p) =>
                    iconOnly ? (
                      // Narrow status bar: fall back to main's compact letter badge.
                      <span key={p.provider} title={getProviderDisplayName(p.provider)}>
                        <ProviderLetterBadge p={p} />
                      </span>
                    ) : (
                      <ProviderSegment
                        key={p.provider}
                        p={p}
                        compact={compact}
                        display={usagePercentageDisplay}
                        mode={statusBarUsageMode}
                      />
                    )
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
                side="top"
                align="start"
                sideOffset={8}
                // Keep the popover (and its drill-in submenus) above the status
                // bar instead of overlapping it — bottom padding ≈ footer height.
                collisionPadding={{ top: 8, bottom: 32, left: 8, right: 8 }}
                className="w-[360px] p-0"
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
                  canSignIn={(provider) => getUsageProviderAccountsSectionId(provider) !== null}
                  onManageAccounts={handleManageAccounts}
                  onUsageDetails={handleUsageDetails}
                  renderRow={(p, rowNode) => {
                    // Every provider drills into its detail panel (parity with the
                    // per-provider dropdowns on main); Claude/Codex additionally get
                    // the account switcher + runtime toggle + Codex reset credits.
                    if (p.provider === 'claude') {
                      return (
                        <ClaudeSwitcherMenu
                          claude={p}
                          compact={compact}
                          iconOnly={false}
                          asSubmenu
                          triggerContent={rowNode}
                        />
                      )
                    }
                    if (p.provider === 'codex') {
                      return (
                        <CodexSwitcherMenu
                          codex={p}
                          compact={compact}
                          iconOnly={false}
                          asSubmenu
                          triggerContent={rowNode}
                        />
                      )
                    }
                    return (
                      <ProviderDetailsMenu
                        provider={p}
                        compact={compact}
                        iconOnly={false}
                        asSubmenu
                        triggerContent={rowNode}
                        ariaLabel={translate(
                          'auto.components.status.bar.UsageRosterPanel.openDetails',
                          'Open usage details'
                        )}
                      />
                    )
                  }}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </UsagePercentageDisplayChangeNotice>
        ) : null}
        {anyVisible && !isEmptyUsageState && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                aria-label={translate(
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
              {translate('auto.components.status.bar.StatusBar.c8857b40f7', 'Refresh usage data')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-3">
        {!isPairedWebClientWindow() ? <CaffeinateStatusSegment iconOnly={iconOnly} /> : null}
        <RemoteServerUpdateStatusSegment iconOnly={iconOnly} />
        <SkillUpdateStatusSegment iconOnly={iconOnly} />
        <UpdateStatusSegment compact={compact} iconOnly={iconOnly} />
        <React.Suspense fallback={null}>
          {petEnabled ? <PetStatusSegment /> : null}
          {showResourceUsage ? (
            <ResourceUsageStatusSegment compact={compact} iconOnly={iconOnly} />
          ) : null}
          {showPorts ? <PortsStatusSegment compact={compact} iconOnly={iconOnly} /> : null}
          {showSsh ? <SshStatusSegment compact={compact} iconOnly={iconOnly} /> : null}
        </React.Suspense>
        {showFloatingTerminalToggle && (
          <FloatingTerminalIconContextMenu currentLocation="status-bar" className="relative">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="relative inline-flex size-5 cursor-pointer items-center justify-center rounded border border-border bg-secondary text-secondary-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                  aria-label={
                    showFloatingWorkspaceAttentionDot
                      ? translate(
                          'auto.components.status.bar.StatusBar.floatingTerminalNewActivity',
                          '{{label}}, new activity',
                          { label: floatingTerminalActionLabel }
                        )
                      : floatingTerminalActionLabel
                  }
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent(TOGGLE_FLOATING_TERMINAL_EVENT))
                  }}
                >
                  <PanelsTopLeft className="size-3.5" />
                  {showFloatingWorkspaceAttentionDot ? (
                    // Why: amber = Orca's "needs attention" convention; ring matches the fill so the dot reads on the icon.
                    <span
                      aria-hidden
                      data-floating-terminal-attention
                      className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-500 ring-1 ring-secondary"
                    />
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {floatingTerminalActionLabel} ({floatingTerminalShortcut})
              </TooltipContent>
            </Tooltip>
          </FloatingTerminalIconContextMenu>
        )}
      </div>

      <StatusBarVisibilityMenu controller={controller} />
    </div>
  )
}
