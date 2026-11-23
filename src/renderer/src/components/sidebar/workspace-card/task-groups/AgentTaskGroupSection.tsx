import React, { useCallback } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import type { AgentTaskGroup } from '../../../../../../shared/agent-task-groups/agent-task-groups'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { launchConversationInAgentTaskGroup } from './agent-task-group-launch'
import { canBrowseTaskGroupFolder } from './agent-task-group-workspace-key'
import { taskGroupFolderLabel } from './agent-task-group-folder'
import { getWorkspacePath } from '@/components/terminal-pane/account-restart/detached/detached-pane-restart-spawn-context'

const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation()

type Props = {
  group: AgentTaskGroup
  index: number
  groupCount: number
  workspaceKey: string
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
  conversationCount: number
  children: React.ReactNode
}

export const AgentTaskGroupSection = React.memo(function AgentTaskGroupSection({
  group,
  index,
  groupCount,
  workspaceKey,
  worktreeId,
  executionHostId,
  conversationCount,
  children
}: Props): React.JSX.Element {
  const t = useTranslate()
  const collapsed = group.collapsed === true
  const setCollapsed = useAppStore((s) => s.setAgentTaskGroupCollapsed)
  const moveGroup = useAppStore((s) => s.moveAgentTaskGroup)
  const deleteGroup = useAppStore((s) => s.deleteAgentTaskGroup)
  const openModal = useAppStore((s) => s.openModal)
  const folderLabel = useAppStore((s) =>
    group.folderPath
      ? taskGroupFolderLabel(getWorkspacePath(s, worktreeId), group.folderPath)
      : null
  )

  const toggle = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setCollapsed(workspaceKey, group.id, !collapsed)
    },
    [collapsed, group.id, setCollapsed, workspaceKey]
  )
  const newConversation = useCallback(() => {
    void launchConversationInAgentTaskGroup({
      worktreeId,
      executionHostId,
      groupId: group.id,
      folderPath: group.folderPath
    })
  }, [executionHostId, group.folderPath, group.id, worktreeId])
  const rename = useCallback(() => {
    openModal('agent-task-group', {
      workspaceKey,
      worktreeId,
      canBrowse: canBrowseTaskGroupFolder(executionHostId),
      groupId: group.id,
      initialName: group.name,
      initialFolderPath: group.folderPath ?? ''
    })
  }, [executionHostId, group.folderPath, group.id, group.name, openModal, workspaceKey, worktreeId])

  const newConversationLabel = t(
    'auto.components.sidebar.AgentTaskGroupSection.newConversation',
    'New Conversation'
  )

  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-expanded={!collapsed}
      aria-label={group.name}
      data-agent-task-group={group.id}
      className="min-w-0"
    >
      <div className="worktree-agent-row-hover group/task-group flex h-6 min-w-0 items-center gap-0.5 rounded-sm pe-0.5">
        <button
          type="button"
          draggable={false}
          className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-sm ps-1 text-left text-xs leading-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
          aria-label={
            collapsed
              ? t('auto.components.sidebar.AgentTaskGroupSection.expand', 'Expand {{name}}', {
                  name: group.name
                })
              : t('auto.components.sidebar.AgentTaskGroupSection.collapse', 'Collapse {{name}}', {
                  name: group.name
                })
          }
          onClick={toggle}
          onMouseDown={stopPropagation}
          onPointerDown={stopPropagation}
          onDoubleClick={stopPropagation}
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
              !collapsed && 'rotate-90'
            )}
          />
          <span className="min-w-0 truncate font-medium text-foreground/90">{group.name}</span>
          {folderLabel ? (
            <span
              className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground/65"
              title={group.folderPath}
            >
              {folderLabel}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {collapsed && (
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/65">
              {t('auto.components.sidebar.AgentTaskGroupSection.chatCount', '{{count}} chats', {
                count: conversationCount,
                defaultValue_one: '{{count}} chat'
              })}
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center transition-opacity can-hover:opacity-0 group-hover/task-group:opacity-100 focus-within:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost-inset"
                size="icon-xs"
                className="size-5 shrink-0"
                aria-label={newConversationLabel}
                onClick={(event) => {
                  event.stopPropagation()
                  newConversation()
                }}
                onMouseDown={stopPropagation}
                onPointerDown={stopPropagation}
              >
                <Plus />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {newConversationLabel}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost-inset"
                size="icon-xs"
                className="size-5 shrink-0"
                aria-label={t(
                  'auto.components.sidebar.AgentTaskGroupSection.actions',
                  'Task group actions'
                )}
                onClick={stopPropagation}
                onMouseDown={stopPropagation}
                onPointerDown={stopPropagation}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-44" onClick={stopPropagation}>
              <DropdownMenuItem onSelect={newConversation}>
                <Plus className="size-3.5" />
                {newConversationLabel}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={rename}>
                <Pencil className="size-3.5" />
                {t('auto.components.sidebar.AgentTaskGroupSection.edit', 'Edit…')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={index === 0}
                onSelect={() => moveGroup(workspaceKey, group.id, -1)}
              >
                <ArrowUp className="size-3.5" />
                {t('auto.components.sidebar.AgentTaskGroupSection.moveUp', 'Move Up')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={index >= groupCount - 1}
                onSelect={() => moveGroup(workspaceKey, group.id, 1)}
              >
                <ArrowDown className="size-3.5" />
                {t('auto.components.sidebar.AgentTaskGroupSection.moveDown', 'Move Down')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => deleteGroup(workspaceKey, group.id)}>
                <Trash2 className="size-3.5" />
                {t('auto.components.sidebar.AgentTaskGroupSection.delete', 'Remove Group')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {collapsed ? null : (
        <div role="group" className="ms-2.5 flex min-w-0 flex-col border-s border-border/60 ps-1">
          {conversationCount === 0 ? (
            <button
              type="button"
              className="worktree-agent-row-hover flex h-6 items-center gap-1 rounded-sm px-1 text-left text-2xs text-muted-foreground/65 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
              onClick={(event) => {
                event.stopPropagation()
                newConversation()
              }}
              onMouseDown={stopPropagation}
              onPointerDown={stopPropagation}
            >
              <Plus className="size-3" />
              {newConversationLabel}
            </button>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  )
})
