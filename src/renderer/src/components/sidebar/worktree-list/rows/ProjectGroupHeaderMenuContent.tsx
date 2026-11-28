import React from 'react'
import { RefreshCw } from 'lucide-react'
import { DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { getFolderProjectGroupRefreshHandler } from './project-group-folder-refresh'
import { stopRepoHeaderMenuEvent } from './header-event-guards'

export function ProjectGroupHeaderMenuContent({
  groupId,
  hostId,
  label,
  projectGroup,
  onRefreshProjectGroup,
  onRename,
  onDelete
}: {
  groupId: string
  hostId?: ExecutionHostId
  label: string
  projectGroup: ProjectGroup | null
  onRefreshProjectGroup?: (projectGroup: ProjectGroup) => void
  onRename: (groupId: string, currentName: string, hostId?: ExecutionHostId) => void
  onDelete: (groupId: string, groupName: string, hostId?: ExecutionHostId) => void
}): React.JSX.Element {
  const t = useTranslate()
  const onRefresh = getFolderProjectGroupRefreshHandler(projectGroup, onRefreshProjectGroup)
  return (
    <DropdownMenuContent
      align="end"
      side="bottom"
      sideOffset={6}
      // Why: Radix portals keep React bubbling through the project header; block menu events from arming row drag/collapse.
      onPointerDown={stopRepoHeaderMenuEvent}
      onMouseDown={stopRepoHeaderMenuEvent}
      onPointerUp={stopRepoHeaderMenuEvent}
      onMouseUp={stopRepoHeaderMenuEvent}
      onClick={stopRepoHeaderMenuEvent}
      onKeyDown={stopRepoHeaderMenuEvent}
    >
      {onRefresh ? (
        <DropdownMenuItem onSelect={onRefresh}>
          <RefreshCw className="size-3.5" />
          {t('auto.components.sidebar.WorktreeList.refreshProjectGroup', 'Refresh projects')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={() => onRename(groupId, label, hostId)}>
        {t('auto.components.sidebar.WorktreeList.4d7b73658c', 'Rename group')}
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onSelect={() => onDelete(groupId, label, hostId)}>
        {t('auto.components.sidebar.WorktreeList.902115cdbe', 'Delete group')}
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}
