import type { JSX } from 'react'
import { LayoutGrid } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  addWorkspaceToGridViewAndShow,
  removeWorkspaceFromGridViewKeepingFocus
} from '@/lib/workspace-grid-view-actions'
import { isWorkspaceGridViewFull } from '@/lib/workspace-grid-view-membership'
import { useAppStore } from '@/store'
import { isKnownGridViewWorkspace } from '@/store/slices/workspace-grid-view'

export function WorkspaceGridViewMenuItems({
  workspaceId,
  disabled
}: {
  workspaceId: string
  disabled: boolean
}): JSX.Element {
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
        {translate(
          'auto.components.sidebar.WorktreeContextMenu.removeFromGridView',
          'Remove from Grid View'
        )}
      </DropdownMenuItem>
    )
  }
  return (
    <DropdownMenuItem
      onSelect={() => addWorkspaceToGridViewAndShow(workspaceId)}
      disabled={disabled || isFull}
    >
      <LayoutGrid className="size-3.5" />
      {translate('auto.components.sidebar.WorktreeContextMenu.addToGridView', 'Add to Grid View')}
    </DropdownMenuItem>
  )
}
