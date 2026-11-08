import React from 'react'
import { Folder, FolderPlus, Plus, SlidersHorizontal } from 'lucide-react'
import { useAppStore } from '@/store'
import { useAgentBucketCounts } from '@/components/dashboard/useAgentBucketCounts'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { openWorkspaceCreationComposerWithTourHandoff } from '../../contextual-tours/workspace-creation-tour-handoff'
import {
  useWorkspaceOptionsFilterBadge,
  WorkspaceOptionsMenuItems
} from '../worktree-list/controls/workspace-options-menu-items'
import { SidebarRailMenu } from './SidebarRailMenu'

type SidebarRailProjectsMenuProps = {
  label: string
  onMenuOpenChange: (open: boolean) => void
}

export function SidebarRailProjectsMenu({
  label,
  onMenuOpenChange
}: SidebarRailProjectsMenuProps): React.JSX.Element {
  const t = useTranslate()
  const openModal = useAppStore((s) => s.openModal)
  const keybindings = useAppStore((s) => s.keybindings)
  const newWorkspaceShortcut = formatOptionalPrimaryShortcutLabel('workspace.create', keybindings)
  const { activeFilterCount } = useWorkspaceOptionsFilterBadge()
  const counts = useAgentBucketCounts()
  const activityCount = counts.attention || counts.working
  const activityCountLabel = activityCount > 99 ? '99+' : String(activityCount)

  return (
    <SidebarRailMenu
      icon={<Folder className="size-4" />}
      label={
        activityCount > 0
          ? t('auto.components.sidebar.rail.projectsWithActivity', '{{label}}, {{count}} active', {
              label,
              count: activityCount
            })
          : label
      }
      align="start"
      badge={
        activityCount > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute right-0.5 bottom-0.5 text-3xs leading-none font-semibold text-foreground"
          >
            {activityCountLabel}
          </span>
        ) : null
      }
      triggerProps={{ 'data-contextual-tour-target': 'workspace-create-control' }}
      contentProps={{ 'data-workspace-board-preserve-open': '' }}
      onOpenChange={onMenuOpenChange}
    >
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <SlidersHorizontal />
          {t('auto.components.sidebar.SidebarWorkspaceOptionsMenu.9919ae1082', 'Workspace options')}
          {activeFilterCount > 0 ? (
            <span className="ml-auto text-muted-foreground">{activeFilterCount}</span>
          ) : null}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent scrollable className="w-72" data-workspace-board-preserve-open="">
          <WorkspaceOptionsMenuItems preserveWorkspaceBoardOpen />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem onSelect={() => openModal('add-repo')}>
        <FolderPlus />
        {t('auto.components.sidebar.SidebarHeader.addProject', 'Add project')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => openWorkspaceCreationComposerWithTourHandoff()}>
        <Plus />
        {t('auto.components.sidebar.SidebarHeader.92154beb7e', 'New workspace')}
        {newWorkspaceShortcut ? (
          <DropdownMenuShortcut>{newWorkspaceShortcut}</DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
    </SidebarRailMenu>
  )
}
