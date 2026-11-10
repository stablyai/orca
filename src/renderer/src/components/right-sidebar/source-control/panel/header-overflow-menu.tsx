import React from 'react'
import {
  List,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Settings2,
  Unlink
} from 'lucide-react'
import type { Worktree } from '../../../../../../shared/worktree/types'
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
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { unnestWorktrees } from '../../../sidebar/workspace-actions/parenting/worktree-unnest'
import { useSourceControlScopeOwner } from './worktree-scope'

type PanelActions = {
  sourceControlViewMode: SourceControlViewMode
  viewModeToggleDisabled: boolean
  onToggleViewMode: () => void
  onChangeBaseRef: () => void
  onRefreshBranchCompare: () => void
  branchCompareRefreshDisabled: boolean
  diffCommentCount: number
  onExpandNotes: () => void
}

export function SourceControlHeaderOverflowMenu({
  panelActions,
  worktree
}: {
  panelActions?: PanelActions
  worktree?: Worktree
}): React.JSX.Element {
  const t = useTranslate()
  const scopeOwner = useSourceControlScopeOwner()
  const ownerWorktree = worktree ?? scopeOwner?.worktree
  const viewModeLabel =
    panelActions?.sourceControlViewMode === 'tree'
      ? t('auto.components.right.sidebar.SourceControl.a91f8e2b01', 'View as list')
      : t('auto.components.right.sidebar.SourceControl.b82e9f3c12', 'View as tree')

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={ownerWorktree ? 'size-6' : 'size-7'}
              aria-label={t(
                'auto.components.right.sidebar.SourceControl.f71c4a8d90',
                'More source control actions'
              )}
            >
              <MoreHorizontal className="size-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {t(
            'auto.components.right.sidebar.SourceControl.f71c4a8d90',
            'More source control actions'
          )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        {panelActions ? (
          <>
            <DropdownMenuItem
              disabled={panelActions.viewModeToggleDisabled}
              onSelect={panelActions.onToggleViewMode}
            >
              {panelActions.sourceControlViewMode === 'tree' ? (
                <List className="size-3.5" />
              ) : (
                <ListTree className="size-3.5" />
              )}
              {viewModeLabel}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={panelActions.onChangeBaseRef}>
              <Settings2 className="size-3.5" />
              {t('auto.components.right.sidebar.SourceControl.476b77745b', 'Change Base Ref')}…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={panelActions.branchCompareRefreshDisabled}
              onSelect={panelActions.onRefreshBranchCompare}
            >
              <RefreshCw className="size-3.5" />
              {t(
                'auto.components.right.sidebar.SourceControl.ed34038d0d',
                'Refresh branch compare'
              )}
            </DropdownMenuItem>
            {panelActions.diffCommentCount > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={panelActions.onExpandNotes}>
                  <MessageSquare className="size-3.5" />
                  {t('auto.components.right.sidebar.SourceControl.cc474e0b8c', 'Notes')}
                  <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                    {panelActions.diffCommentCount}
                  </span>
                </DropdownMenuItem>
              </>
            ) : null}
          </>
        ) : null}
        {ownerWorktree ? (
          <>
            {panelActions ? <DropdownMenuSeparator /> : null}
            {/* Same unlink as the sidebar's Parent & Children menu; the worktree itself stays. */}
            <DropdownMenuItem
              onSelect={() =>
                void unnestWorktrees([ownerWorktree], useAppStore.getState().updateWorktreeLineage)
              }
            >
              <Unlink className="size-3.5" />
              {t('auto.components.sidebar.WorktreeContextMenu.579b1a8e61', 'Remove from Parent')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
