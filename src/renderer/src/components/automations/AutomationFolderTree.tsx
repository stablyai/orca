import React from 'react'
import { ChevronRight, FolderPlus, MoreHorizontal, Palette, Pencil, Trash2 } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { Automation, AutomationFolder } from '../../../../shared/automations-types'
import { resolveAutomationFolderColor } from './automation-folder-colors'

export const UNFILED_FOLDER_ID = '__unfiled__'

export type AutomationFolderGroup = {
  /** The folder entity, or null for the always-present Unfiled pseudo-folder. */
  folder: AutomationFolder | null
  automations: Automation[]
}

type AutomationFolderTreeProps = {
  groups: AutomationFolderGroup[]
  collapsedUnfiled: boolean
  onToggleFolder: (group: AutomationFolderGroup) => void
  onCreateFolder: () => void
  onRenameFolder: (folder: AutomationFolder) => void
  onRecolorFolder: (folder: AutomationFolder) => void
  onDeleteFolder: (folder: AutomationFolder) => void
  renderRow: (automation: Automation) => React.ReactNode
}

function FolderHeaderMenu({
  folder,
  onRename,
  onRecolor,
  onDelete
}: {
  folder: AutomationFolder
  onRename: (folder: AutomationFolder) => void
  onRecolor: (folder: AutomationFolder) => void
  onDelete: (folder: AutomationFolder) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate(
            'auto.components.automations.AutomationFolderTree.folderActions',
            'Folder actions'
          )}
          onClick={(event) => event.stopPropagation()}
          className="opacity-0 transition-opacity group-hover/folder:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={() => onRename(folder)}>
          <Pencil className="size-3.5" />
          {translate('auto.components.automations.AutomationFolderTree.rename', 'Rename')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onRecolor(folder)}>
          <Palette className="size-3.5" />
          {translate('auto.components.automations.AutomationFolderTree.recolor', 'Change color')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(folder)}>
          <Trash2 className="size-3.5" />
          {translate('auto.components.automations.AutomationFolderTree.delete', 'Delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FolderSection({
  group,
  collapsed,
  onToggle,
  onRename,
  onRecolor,
  onDelete,
  renderRow
}: {
  group: AutomationFolderGroup
  collapsed: boolean
  onToggle: (group: AutomationFolderGroup) => void
  onRename: (folder: AutomationFolder) => void
  onRecolor: (folder: AutomationFolder) => void
  onDelete: (folder: AutomationFolder) => void
  renderRow: (automation: Automation) => React.ReactNode
}): React.JSX.Element {
  const { folder, automations } = group
  const isUnfiled = folder === null
  const dotColor = folder ? resolveAutomationFolderColor(folder.color) : null
  const name = isUnfiled
    ? translate('auto.components.automations.AutomationFolderTree.unfiled', 'Unfiled')
    : folder.name

  return (
    <Collapsible open={!collapsed} onOpenChange={() => onToggle(group)} className="mb-1">
      <div className="group/folder flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/40">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none"
          >
            <ChevronRight
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform',
                !collapsed && 'rotate-90'
              )}
            />
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                dotColor ? '' : 'bg-muted-foreground/40'
              )}
              style={dotColor ? { backgroundColor: dotColor } : undefined}
              aria-hidden
            />
            <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {name}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
              {automations.length}
            </span>
          </button>
        </CollapsibleTrigger>
        {folder ? (
          <FolderHeaderMenu
            folder={folder}
            onRename={onRename}
            onRecolor={onRecolor}
            onDelete={onDelete}
          />
        ) : null}
      </div>
      <CollapsibleContent className="pt-1">
        {automations.length > 0 ? (
          automations.map((automation) => (
            <React.Fragment key={automation.id}>{renderRow(automation)}</React.Fragment>
          ))
        ) : (
          <div className="px-3 pb-1 text-xs text-muted-foreground/70">
            {translate('auto.components.automations.AutomationFolderTree.empty', 'No automations')}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function AutomationFolderTree({
  groups,
  collapsedUnfiled,
  onToggleFolder,
  onCreateFolder,
  onRenameFolder,
  onRecolorFolder,
  onDeleteFolder,
  renderRow
}: AutomationFolderTreeProps): React.JSX.Element {
  return (
    <div>
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-[11px] font-medium uppercase text-muted-foreground">
          {translate('auto.components.automations.AutomationFolderTree.folders', 'Folders')}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.automations.AutomationFolderTree.newFolder',
                'New folder'
              )}
              onClick={onCreateFolder}
            >
              <FolderPlus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.automations.AutomationFolderTree.newFolder', 'New folder')}
          </TooltipContent>
        </Tooltip>
      </div>
      {groups.map((group) => {
        const collapsed = group.folder ? group.folder.isCollapsed : collapsedUnfiled
        return (
          <FolderSection
            key={group.folder?.id ?? UNFILED_FOLDER_ID}
            group={group}
            collapsed={collapsed}
            onToggle={onToggleFolder}
            onRename={onRenameFolder}
            onRecolor={onRecolorFolder}
            onDelete={onDeleteFolder}
            renderRow={renderRow}
          />
        )
      })}
    </div>
  )
}
