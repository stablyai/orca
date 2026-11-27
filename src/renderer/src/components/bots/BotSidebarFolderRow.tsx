import React from 'react'
import {
  ChevronRight,
  Ellipsis,
  Folder,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Pencil
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TruncatedSidebarLabel } from '@/components/ui/truncated-sidebar-label'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotSidebarFolder } from '../../../../shared/bots/bot-sidebar-folders'
import type { BotFolderDialogState } from './BotFolderDialogs'

/** One folder in the Bots tree: its fold, its name, and the menu that edits only this folder. */
export function BotSidebarFolderRow({
  folder,
  depth,
  expanded,
  hasChildren,
  onToggle,
  onAction
}: {
  folder: BotSidebarFolder
  depth: number
  expanded: boolean
  hasChildren: boolean
  onToggle: () => void
  onAction: (action: BotFolderDialogState) => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('bots.folders.actions', 'Folder actions for {{name}}', { name: folder.name })
  const FolderIcon = expanded && hasChildren ? FolderOpen : Folder
  return (
    <div className="min-w-0" style={{ paddingInlineStart: `min(${depth * 12}px, 40%)` }}>
      <div className="ml-1 flex min-w-0 items-center rounded-md pr-1 hover:bg-sidebar-accent">
        <button
          type="button"
          disabled={!hasChildren}
          aria-expanded={hasChildren ? expanded : undefined}
          aria-label={folder.name}
          data-bot-folder-row={folder.id}
          className={cn(
            'flex min-h-7 min-w-0 flex-1 items-center gap-1 rounded-md pl-1.25 text-start text-[13px] leading-5 outline-none select-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset',
            hasChildren && 'cursor-pointer'
          )}
          onClick={onToggle}
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            {hasChildren ? (
              <ChevronRight
                className={cn('size-3.5 motion-safe:transition-transform', expanded && 'rotate-90')}
              />
            ) : null}
          </span>
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <TruncatedSidebarLabel text={folder.name} className="min-w-0 flex-1" />
        </button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              className="shrink-0"
              aria-label={label}
              data-repo-header-action=""
            >
              <Ellipsis className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom" sideOffset={6} className="w-48">
            <DropdownMenuItem onSelect={() => onAction({ type: 'rename', folderId: folder.id })}>
              <Pencil className="size-3.5" />
              {t('bots.folders.renameTitle', 'Rename folder')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction({ type: 'create', parentId: folder.id })}>
              <FolderPlus className="size-3.5" />
              {t('bots.folders.createChildTitle', 'New subfolder')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction({ type: 'move', folderId: folder.id })}>
              <FolderInput className="size-3.5" />
              {t('bots.folders.move', 'Move folder…')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onAction({ type: 'remove', folderId: folder.id })}>
              <FolderMinus className="size-3.5" />
              {t('bots.folders.remove', 'Remove folder…')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
