import React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { agentTaskGroupWorkspaceKey } from './agent-task-group-workspace-key'
import { useAgentTaskGroupsList } from './TaskGroupedAgentList'

const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation()

/** Leads a card title once its workspace has task groups, and folds its conversation list. */
export function WorktreeCardTaskGroupsToggle({
  worktreeId,
  executionHostId
}: {
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const list = useAgentTaskGroupsList(worktreeId, executionHostId)
  const setListCollapsed = useAppStore((s) => s.setAgentTaskGroupsListCollapsed)
  if (list === 'none') {
    return null
  }
  const folded = list === 'folded'
  return (
    <button
      type="button"
      draggable={false}
      className="-ms-1 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
      aria-expanded={!folded}
      aria-label={
        folded
          ? t('auto.components.sidebar.WorktreeCardTaskGroupsToggle.expand', 'Show task groups')
          : t('auto.components.sidebar.WorktreeCardTaskGroupsToggle.collapse', 'Hide task groups')
      }
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setListCollapsed(agentTaskGroupWorkspaceKey(worktreeId, executionHostId), !folded)
      }}
      onMouseDown={stopPropagation}
      onPointerDown={stopPropagation}
      onDoubleClick={stopPropagation}
    >
      <ChevronRight
        className={cn(
          'size-3 transition-transform duration-150 motion-reduce:transition-none',
          !folded && 'rotate-90'
        )}
      />
    </button>
  )
}
