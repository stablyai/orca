import React from 'react'
import { CircleHelp, Crosshair, Kanban, Settings } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { requestScrollToCurrentWorkspaceReveal } from '@/lib/scroll-to-current-workspace-status'
import { useTranslate } from '@/i18n/use-translate'
import { useSidebarHelpMenu } from '../SidebarSettingsHelpMenu'
import { SidebarRailMenu } from './SidebarRailMenu'

type SidebarRailSettingsMenuProps = {
  workspaceBoardOpen: boolean
  hint?: string
  onWorkspaceBoardClick: () => void
}

export function SidebarRailSettingsMenu({
  workspaceBoardOpen,
  hint,
  onWorkspaceBoardClick
}: SidebarRailSettingsMenuProps): React.JSX.Element {
  const t = useTranslate()
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const keybindings = useAppStore((s) => s.keybindings)
  const settingsShortcut = formatOptionalPrimaryShortcutLabel('app.settings', keybindings)
  const { helpItems, feedbackDialog, prepareHelpMenu } = useSidebarHelpMenu()
  const settingsLabel = t('auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998', 'Settings')

  return (
    <>
      <SidebarRailMenu
        icon={<Settings className="size-4" />}
        label={settingsLabel}
        align="end"
        hint={hint}
        onOpenChange={(open) => {
          if (open) {
            prepareHelpMenu()
          }
        }}
      >
        <DropdownMenuItem onSelect={requestScrollToCurrentWorkspaceReveal}>
          <Crosshair />
          {t(
            'auto.components.sidebar.ScrollToCurrentWorkspaceToolbarButton.23989bb663',
            'Reveal active workspace'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem data-workspace-board-trigger="" onSelect={onWorkspaceBoardClick}>
          <Kanban />
          {workspaceBoardOpen
            ? t('auto.components.sidebar.SidebarToolbar.a30e34eb5c', 'Close workspace board')
            : t('auto.components.sidebar.SidebarToolbar.49f62c5665', 'Workspace board')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openSettingsPage}>
          <Settings />
          {settingsLabel}
          {settingsShortcut ? (
            <DropdownMenuShortcut>{settingsShortcut}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <CircleHelp />
            {t('auto.components.sidebar.SidebarSettingsHelpMenu.2991a0106c', 'Help')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent scrollable className="w-52">
            {helpItems}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </SidebarRailMenu>
      {feedbackDialog}
    </>
  )
}
