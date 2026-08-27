import React from 'react'
import {
  Folder,
  FolderTree,
  List,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Settings2
} from 'lucide-react'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export function SourceControlHeaderOverflowMenu({
  sourceControlViewMode,
  sourceControlCompactFolders,
  onToggleCompactFolders,
  viewModeToggleDisabled,
  onToggleViewMode,
  onChangeBaseRef,
  onRefreshBranchCompare,
  branchCompareRefreshDisabled,
  diffCommentCount,
  onExpandNotes
}: {
  sourceControlViewMode: SourceControlViewMode
  sourceControlCompactFolders: boolean
  onToggleCompactFolders: () => void
  viewModeToggleDisabled: boolean
  onToggleViewMode: () => void
  onChangeBaseRef: () => void
  onRefreshBranchCompare: () => void
  branchCompareRefreshDisabled: boolean
  diffCommentCount: number
  onExpandNotes: () => void
}): React.JSX.Element {
  const viewModeLabel =
    sourceControlViewMode === 'tree'
      ? translate('auto.components.right.sidebar.SourceControl.a91f8e2b01', 'View as list')
      : translate('auto.components.right.sidebar.SourceControl.b82e9f3c12', 'View as tree')
  // Compaction only changes how a tree draws folder chains, so it is inert in list view.
  const compactFoldersLabel = sourceControlCompactFolders
    ? translate('auto.components.right.sidebar.SourceControl.c93d5a7e24', 'Expand folder paths')
    : translate('auto.components.right.sidebar.SourceControl.d04e6b8f35', 'Compact folder paths')

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-7 text-muted-foreground hover:text-foreground"
                aria-label={translate(
                  'auto.components.right.sidebar.SourceControl.f71c4a8d90',
                  'More source control actions'
                )}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate(
            'auto.components.right.sidebar.SourceControl.f71c4a8d90',
            'More source control actions'
          )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <DropdownMenuItem disabled={viewModeToggleDisabled} onSelect={onToggleViewMode}>
          {sourceControlViewMode === 'tree' ? (
            <List className="size-3.5" />
          ) : (
            <ListTree className="size-3.5" />
          )}
          {viewModeLabel}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={viewModeToggleDisabled || sourceControlViewMode !== 'tree'}
          onSelect={onToggleCompactFolders}
        >
          {sourceControlCompactFolders ? (
            <FolderTree className="size-3.5" />
          ) : (
            <Folder className="size-3.5" />
          )}
          {compactFoldersLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onChangeBaseRef}>
          <Settings2 className="size-3.5" />
          {translate('auto.components.right.sidebar.SourceControl.476b77745b', 'Change Base Ref')}…
        </DropdownMenuItem>
        <DropdownMenuItem disabled={branchCompareRefreshDisabled} onSelect={onRefreshBranchCompare}>
          <RefreshCw className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.SourceControl.ed34038d0d',
            'Refresh branch compare'
          )}
        </DropdownMenuItem>
        {diffCommentCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onExpandNotes}>
              <MessageSquare className="size-3.5" />
              {translate('auto.components.right.sidebar.SourceControl.cc474e0b8c', 'Notes')}
              <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                {diffCommentCount}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
