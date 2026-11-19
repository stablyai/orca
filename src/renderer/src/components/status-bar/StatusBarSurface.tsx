import { PanelsTopLeft, RefreshCw } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { UsageRosterPanel } from './usage/UsageRosterPanel'
import {
  STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS,
  shouldOpenStatusBarContextMenu
} from './composition/status-bar-context-menu-policy'
import { StatusBarUsageEmptyCta } from './usage/StatusBarUsageEmptyCta'
import { StatusBarUsageChangeNotices } from './usage/StatusBarUsageChangeNotices'
import { UpdateStatusSegment } from './updates/UpdateStatusSegment'
import { SkillUpdateStatusSegment } from './updates/SkillUpdateStatusSegment'
import { AgentCliUpdateStatusSegment } from './updates/AgentCliUpdateStatusSegment'
import { NativeChatResumeStatusSegment } from './NativeChatResumeStatusSegment'
import { CaffeinateStatusSegment } from './CaffeinateStatusSegment'
import { PluginsStatusSegment } from './plugins/PluginsStatusSegment'
import { PluginStatusBarItems } from './plugins/PluginStatusBarItems'
import { RemoteServerUpdateStatusSegment } from './updates/RemoteServerUpdateStatusSegment'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/components/floating-terminal/workspace/floating-workspace-open-intent'
import { FloatingTerminalIconContextMenu } from '@/components/floating-terminal/trigger/FloatingTerminalIconContextMenu'
import { ClaudeSwitcherMenu } from './accounts/ClaudeSwitcherMenu'
import { CodexSwitcherMenu } from './accounts/CodexSwitcherMenu'
import { ProviderDetailsMenu } from './usage/ProviderDetailsMenu'
import { AntigravityUsageMenu } from './usage/AntigravityUsageMenu'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/overlay-interaction/close-all-context-menus'
import { ProviderSegment } from './usage/StatusBarProviderSegment'
import { UsageUnitLabel, usageChipShowsPercentage } from './usage/usage-unit-label'
import { useStatusBarController } from './composition/use-status-bar-controller'
import { scrollStripSidewaysOnWheel } from '../tab-bar/strip/tab-strip-scroll-metrics'
import { isOwnerNotSetUpPlaceholder } from './usage/owner-usage-rate-limits'
import { getAccountOwnerKey } from './accounts/owner-account-rows'
import { StatusBarVisibilityMenu } from './composition/StatusBarVisibilityMenu'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { GitBlameStatusSegment } from './GitBlameStatusSegment'

const PetStatusSegment = lazyWithRetry(() =>
  import('./PetStatusSegment').then((module) => ({ default: module.PetStatusSegment }))
)
const ResourceUsageStatusSegment = lazyWithRetry(() =>
  import('./resources/ResourceUsageStatusSegment').then((module) => ({
    default: module.ResourceUsageStatusSegment
  }))
)
const PortsStatusSegment = lazyWithRetry(() =>
  import('./host-connections/PortsStatusSegment').then((module) => ({
    default: module.PortsStatusSegment
  }))
)
const SshStatusSegment = lazyWithRetry(() =>
  import('./host-connections/SshStatusSegment').then((module) => ({
    default: module.SshStatusSegment
  }))
)

/** Vertical wheel scrolls the segments sideways, as the tab strip does; React's onWheel is passive. */
function attachSidewaysWheel(el: HTMLDivElement | null): (() => void) | undefined {
  if (!el) {
    return undefined
  }
  const onWheel = (event: WheelEvent): void => {
    scrollStripSidewaysOnWheel(el, event)
  }
  el.addEventListener('wheel', onWheel, { passive: false })
  return () => el.removeEventListener('wheel', onWheel)
}

export type StatusBarProps = {
  floatingTerminalOpen: boolean
}

export function StatusBarSurface({
  floatingTerminalOpen
}: StatusBarProps): React.JSX.Element | null {
  const t = useTranslate()
  // Memoized labels still need to follow language changes.
  useTranslation()
  const controller = useStatusBarController(floatingTerminalOpen)
  if (!controller) {
    return null
  }
  const {
    antigravityAccounts,
    anyFetching,
    anyVisible,
    canSignInFromUsageRow,
    floatingTerminalActionLabel,
    floatingTerminalShortcut,
    handleManageAccounts,
    handleOpenProviderAccounts,
    handleRefresh,
    handleUsageDetails,
    handleUsageMenuOpenChange,
    hasVisibleUsageMeters,
    isEmptyUsageState,
    isRefreshing,
    ownerUsage,
    petEnabled,
    remoteOwner,
    rosterProviders,
    setMenuOpen,
    setMenuPoint,
    setStatusBarUsageMode,
    showEmptyUsageCta,
    showFloatingTerminalToggle,
    showFloatingWorkspaceAttentionDot,
    showGitBlame,
    showPorts,
    showResourceUsage,
    showSsh,
    statusBarUsageMode,
    usageMenuFocusHandoff,
    usageMenuOpen,
    usagePercentageDisplay
  } = controller
  const showUnitLabel = rosterProviders.some((p) =>
    usageChipShowsPercentage(p, statusBarUsageMode, t)
  )

  return (
    <div
      data-orca-status-bar=""
      // Why: one line at any width. overflow-clip (not hidden) so focus can't scroll the bar; the clip margin spares focus rings and badge dots.
      className="flex items-center h-6 min-h-[24px] px-3 gap-4 overflow-clip [overflow-clip-margin:3px] whitespace-nowrap border-t border-border bg-[var(--bg-titlebar,var(--card))] text-xs select-none shrink-0 relative"
      onContextMenuCapture={(event) => {
        if (!shouldOpenStatusBarContextMenu(event.target)) {
          return
        }
        // Close peer menus and anchor at the cursor so repeated right-clicks reposition the menu.
        event.preventDefault()
        window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
        const bounds = event.currentTarget.getBoundingClientRect()
        setMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        setMenuOpen(true)
      }}
    >
      {/* Why fixed priority instead of density levels: choosing a layout from the bar's own measured
          widths fed back into the next measurement and could loop (React #185). Usage gives way
          first; everything it clips stays one click away in its popover. */}
      <div className="flex min-w-0 flex-1 items-center overflow-clip [overflow-clip-margin:3px]">
        <div className="flex shrink-0 items-center gap-3">
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
                    className="inline-flex items-center gap-3 rounded px-1 py-0.5 hover:bg-accent/70"
                    aria-label={t('auto.components.status.bar.UsageRosterPanel.title', 'Usage')}
                  >
                    {showUnitLabel ? <UsageUnitLabel display={usagePercentageDisplay} /> : null}
                    {rosterProviders.map((p) => (
                      <ProviderSegment
                        key={p.provider}
                        p={p}
                        compact={false}
                        display={usagePercentageDisplay}
                        mode={statusBarUsageMode}
                      />
                    ))}
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
                            compact={false}
                            iconOnly={false}
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
                            compact={false}
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
                            compact={false}
                            iconOnly={false}
                            asSubmenu
                            triggerContent={rowNode}
                          />
                        )
                      }
                      return (
                        <ProviderDetailsMenu
                          provider={p}
                          compact={false}
                          iconOnly={false}
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
      </div>

      {/* Why: attention segments never give way to usage; wider than the bar on their own, they scroll. The max width leaves the bar gap that still follows the emptied usage area. */}
      <div
        ref={attachSidewaysWheel}
        className="flex min-w-0 max-w-[calc(100%-1rem)] shrink-0 items-center self-stretch overflow-x-auto scrollbar-none"
      >
        <div className="flex w-max items-center gap-3">
          {!isPairedWebClientWindow() ? (
            <>
              <PluginsStatusSegment />
              <PluginStatusBarItems iconOnly={false} />
              <CaffeinateStatusSegment iconOnly={false} />
            </>
          ) : null}
          <RemoteServerUpdateStatusSegment iconOnly={false} />
          <SkillUpdateStatusSegment iconOnly={false} />
          <AgentCliUpdateStatusSegment iconOnly={false} />
          <NativeChatResumeStatusSegment iconOnly={false} />
          <UpdateStatusSegment compact={false} iconOnly={false} />
          {showGitBlame ? <GitBlameStatusSegment iconOnly={false} /> : null}
          <React.Suspense fallback={null}>
            {petEnabled ? <PetStatusSegment /> : null}
            {showResourceUsage ? (
              <ResourceUsageStatusSegment compact={false} iconOnly={false} />
            ) : null}
            {showPorts ? <PortsStatusSegment compact={false} iconOnly={false} /> : null}
            {showSsh ? <SshStatusSegment compact={false} iconOnly={false} /> : null}
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
                        ? t(
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
      </div>

      <StatusBarVisibilityMenu controller={controller} />
    </div>
  )
}
