import type { JSX } from 'react'
import { LayoutGrid } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import {
  addWorkspaceToGridViewAndShow,
  removeWorkspaceFromGridViewKeepingFocus
} from '@/lib/workspace/grid-view/workspace-grid-view-actions'
import {
  isWorkspaceGridViewFull,
  WORKSPACE_GRID_VIEW_MAX_MEMBERS
} from '@/lib/workspace/grid-view/workspace-grid-view-membership'
import { useAppStore } from '@/store'
import { isKnownGridViewWorkspace } from '@/store/slices/workspace-grid-view/workspace-grid-view'

export function WorkspaceGridViewMenuItems({
  workspaceId,
  disabled
}: {
  workspaceId: string
  disabled: boolean
}): JSX.Element {
  const t = useTranslate()
  const isMember = useAppStore((state) => state.workspaceGridViewMemberIds.includes(workspaceId))
  const isFull = useAppStore((state) =>
    isWorkspaceGridViewFull(state.workspaceGridViewMemberIds, (memberId) =>
      isKnownGridViewWorkspace(state, memberId)
    )
  )

  if (isMember) {
    return (
      <DropdownMenuItem
        onSelect={() => removeWorkspaceFromGridViewKeepingFocus(workspaceId)}
        disabled={disabled}
      >
        <LayoutGrid className="size-3.5" />
        {t(
          'auto.components.sidebar.WorktreeContextMenu.removeFromGridView',
          'Remove from Grid View'
        )}
      </DropdownMenuItem>
    )
  }
  const addItem = (
    <DropdownMenuItem
      onSelect={() => addWorkspaceToGridViewAndShow(workspaceId)}
      disabled={disabled || isFull}
      className={isFull ? 'data-[disabled]:pointer-events-auto' : undefined}
    >
      <LayoutGrid className="size-3.5" />
      {t('auto.components.sidebar.WorktreeContextMenu.addToGridView', 'Add to Grid View')}
    </DropdownMenuItem>
  )
  if (!isFull) {
    return addItem
  }
  // Why: a full grid only greys the item out, so the hover says why.
  return (
    <Tooltip>
      <TooltipTrigger asChild>{addItem}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[200px]">
        {t(
          'auto.components.sidebar.WorktreeContextMenu.gridViewFull',
          'Grid View holds up to {{value0}} workspaces. Remove one to add another.',
          { value0: WORKSPACE_GRID_VIEW_MAX_MEMBERS }
        )}
      </TooltipContent>
    </Tooltip>
  )
}
