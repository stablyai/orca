import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Kanban } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getWorkspaceStatusVisualMeta } from './workspace-status'
import type { WorkspaceStatusDefinition } from '../../../../shared/worktree/types'

export function WorktreeStatusMenuItems(props: {
  contextWorkspaceStatus: string
  deletingContext: boolean
  isMultiContext: boolean
  onAssignWorkspaceStatus: (status: string) => void
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={props.deletingContext}>
        <Kanban className="size-3.5" />
        {props.isMultiContext
          ? translate('auto.components.sidebar.WorktreeContextMenu.56cde9e8e6', 'Move Statuses To')
          : translate('auto.components.sidebar.WorktreeContextMenu.84cdbb7e30', 'Move to Status')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        <DropdownMenuRadioGroup value={props.contextWorkspaceStatus}>
          {props.workspaceStatuses.map((status) => {
            const meta = getWorkspaceStatusVisualMeta(status)
            return (
              <DropdownMenuRadioItem
                key={status.id}
                value={status.id}
                onSelect={() => props.onAssignWorkspaceStatus(status.id)}
              >
                <meta.icon className={cn('size-3.5', meta.tone)} />
                {status.label}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
