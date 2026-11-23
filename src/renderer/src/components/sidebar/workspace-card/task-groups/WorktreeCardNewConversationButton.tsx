import React from 'react'
import { Plus } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { launchConversationInAgentTaskGroup } from './agent-task-group-launch'

const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation()

/** Beside the card title: a standalone conversation in this workspace, outside every task group. */
export function WorktreeCardNewConversationButton({
  worktreeId,
  executionHostId
}: {
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const label = t(
    'auto.components.sidebar.WorktreeCardNewConversationButton.label',
    'New Conversation'
  )
  return (
    <button
      type="button"
      draggable={false}
      className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void launchConversationInAgentTaskGroup({ worktreeId, executionHostId })
      }}
      onMouseDown={stopPropagation}
      onPointerDown={stopPropagation}
      onDoubleClick={stopPropagation}
    >
      <Plus className="size-3" />
    </button>
  )
}
