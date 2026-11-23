import { PanelsTopLeft } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { shouldOpenStatusBarContextMenu } from './composition/status-bar-context-menu-policy'
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
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/overlay-interaction/close-all-context-menus'
import { useStatusBarController } from './composition/use-status-bar-controller'
import { StatusBarUsageArea } from './StatusBarUsageArea'
import { scrollStripSidewaysOnWheel } from '../tab-bar/strip/tab-strip-scroll-metrics'
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
    floatingTerminalActionLabel,
    floatingTerminalShortcut,
    petEnabled,
    setMenuOpen,
    setMenuPoint,
    showFloatingTerminalToggle,
    showFloatingWorkspaceAttentionDot,
    showGitBlame,
    showPorts,
    showResourceUsage,
    showSsh,
    usageHidden
  } = controller
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
      {usageHidden ? (
        <div aria-hidden className="flex-1" />
      ) : (
        <StatusBarUsageArea controller={controller} />
      )}

      {/* Why: attention segments shrink only after usage reaches its minimum, then scroll instead of
          compressing; the row's padding keeps edge badges and focus rings inside the scroll box. */}
      <div
        ref={attachSidewaysWheel}
        className="-mx-1 flex min-w-0 items-center self-stretch overflow-x-auto scrollbar-none"
      >
        <div className="flex w-max items-center gap-3 px-1">
          {!isPairedWebClientWindow() ? (
            <>
              <PluginsStatusSegment />
              <PluginStatusBarItems />
              <CaffeinateStatusSegment />
            </>
          ) : null}
          <RemoteServerUpdateStatusSegment />
          <SkillUpdateStatusSegment />
          <AgentCliUpdateStatusSegment />
          <NativeChatResumeStatusSegment />
          <UpdateStatusSegment />
          {showGitBlame ? <GitBlameStatusSegment /> : null}
          <React.Suspense fallback={null}>
            {petEnabled ? <PetStatusSegment /> : null}
            {showResourceUsage ? <ResourceUsageStatusSegment /> : null}
            {showPorts ? <PortsStatusSegment /> : null}
            {showSsh ? <SshStatusSegment /> : null}
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
