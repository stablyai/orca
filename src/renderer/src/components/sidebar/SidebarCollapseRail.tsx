import React from 'react'
import { PanelLeftOpen, Plus, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatOptionalPrimaryShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'

/** dsh-style collapsed sidebar width: icon rail, no resize. */
export const SIDEBAR_COLLAPSE_RAIL_WIDTH = 56

type SidebarCollapseRailProps = {
  onExpand: () => void
  onNewWorkspace: () => void
  onOpenSettings: () => void
}

// Why props over store reads: the rail stays a pure function of its three
// actions, so the collapse wiring is tested through Sidebar's store instead.
const SidebarCollapseRail = React.memo(function SidebarCollapseRail({
  onExpand,
  onNewWorkspace,
  onOpenSettings
}: SidebarCollapseRailProps): React.JSX.Element {
  const t = useTranslate()
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const keybindings = useAppStore((s) => s.keybindings)
  // Why primary: Toggle Sidebar binds one default (Mod+B); when the user
  // unbinds it the tooltip falls back to the bare label like dsh does.
  const toggleSidebarShortcut = formatOptionalPrimaryShortcutLabel(
    'sidebar.left.toggle',
    keybindings
  )
  const newWorkspaceShortcut = formatOptionalPrimaryShortcutLabel('workspace.create', keybindings)
  const expandLabel = t(
    'auto.components.sidebar.SidebarCollapseRail.expandSidebar',
    'Expand sidebar'
  )
  const newWorkspaceLabel = t('auto.components.sidebar.SidebarHeader.92154beb7e', 'New workspace')
  return (
    <div
      className="flex h-full w-14 flex-col items-center bg-worktree-sidebar py-2"
      data-sidebar-collapse-rail=""
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            className="text-muted-foreground"
            aria-label={expandLabel}
            aria-keyshortcuts={toggleSidebarShortcut ?? undefined}
            aria-expanded={false}
            onClick={onExpand}
          >
            <PanelLeftOpen className="size-3.5" strokeWidth={2.25} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {expandLabel}
          {toggleSidebarShortcut ? (
            <span className="ml-1.5 text-background/60">{toggleSidebarShortcut}</span>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            className="text-muted-foreground"
            aria-label={newWorkspaceLabel}
            aria-keyshortcuts={newWorkspaceShortcut ?? undefined}
            onClick={onNewWorkspace}
          >
            <Plus className="size-3.5" strokeWidth={2.25} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {newWorkspaceLabel}
          {newWorkspaceShortcut ? (
            <span className="ml-1.5 text-background/60">{newWorkspaceShortcut}</span>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <div className="min-h-0 flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            className="text-muted-foreground"
            aria-label={t('auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998', 'Settings')}
            onClick={onOpenSettings}
          >
            <Settings className="size-3.5" strokeWidth={2.25} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {t('auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998', 'Settings')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
})

export default SidebarCollapseRail
