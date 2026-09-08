import { useMemo, useState } from 'react'
import { Folder, GitBranch, GitBranchPlus, Plus, SquareTerminal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { runWorktreeDelete } from '@/components/sidebar/delete-worktree-flow'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { reviewStateLabel } from '@/components/dashboard-popout/agent-dashboard-filter-options'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import StatusIndicator from '@/components/sidebar/StatusIndicator'
import { resolveRepoHeaderColor } from '@/components/sidebar/project-header-color'
import { useWorktreeActivityStatuses } from '@/components/sidebar/use-worktree-activity-statuses'
import { getReviewLabel, ReviewIcon } from '@/components/sidebar/worktree-review-helpers'
import {
  getWorkspaceStatus,
  getWorkspaceStatusVisualMeta
} from '@/components/sidebar/workspace-status'
import { translate } from '@/i18n/i18n'
import { getWorktreeStatusLabel } from '@/lib/worktree-status'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { getWorktreeOnHostFromState } from '@/store/selectors'
import {
  groupWorkspaceMultiplexerCatalog,
  type WorkspaceMultiplexerCatalogItem
} from './workspace-multiplexer-model'

export function WorkspaceMultiplexerPicker({
  items,
  slotCountByIdentity,
  terminalCountByIdentity,
  onSelect,
  onWorkspaceDragStart,
  onWorkspaceDragEnd
}: {
  items: readonly WorkspaceMultiplexerCatalogItem[]
  slotCountByIdentity: ReadonlyMap<string, number>
  terminalCountByIdentity: ReadonlyMap<string, number>
  onSelect: (item: WorkspaceMultiplexerCatalogItem) => void
  onWorkspaceDragStart: (item: WorkspaceMultiplexerCatalogItem) => void
  onWorkspaceDragEnd: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => groupWorkspaceMultiplexerCatalog(items), [items])
  const worktreeIds = useMemo(() => items.map((item) => item.worktreeId), [items])
  const activityStatuses = useWorktreeActivityStatuses(worktreeIds)
  const workspaceStatuses = useAppStore((state) => state.workspaceStatuses)
  const handleCreateWorktree = (): void => {
    setOpen(false)
    queueMicrotask(() =>
      useAppStore
        .getState()
        .openModal('new-workspace-composer', { telemetrySource: 'command_palette' })
    )
  }
  const handleDeleteWorktree = (item: WorkspaceMultiplexerCatalogItem): void => {
    const state = useAppStore.getState()
    const worktree =
      getWorktreeOnHostFromState(state, item.worktreeId, item.executionHostId) ??
      getWorktreeOnHostFromState(state, item.worktreeId, undefined)
    if (!worktree || worktree.isMainWorktree) {
      return
    }
    setOpen(false)
    queueMicrotask(() =>
      runWorktreeDelete(worktree.id, {
        ...(worktree.instanceId ? { expectedInstanceId: worktree.instanceId } : {}),
        ...(worktree.hostId ? { expectedHostId: worktree.hostId } : {})
      })
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5">
          <Plus className="size-3.5" />
          {translate(
            'auto.components.workspace.multiplexer.WorkspaceMultiplexerPicker.add',
            'Add workspace'
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(30rem,calc(100vw-2rem))] p-0">
        <Command>
          <CommandInput
            placeholder={translate(
              'auto.components.workspace.multiplexer.WorkspaceMultiplexerPicker.search',
              'Search workspaces...'
            )}
          />
          <CommandList>
            <CommandEmpty>
              {translate(
                'auto.components.workspace.multiplexer.WorkspaceMultiplexerPicker.empty',
                'No workspaces found.'
              )}
            </CommandEmpty>
            {groups.map((group) => (
              <CommandGroup
                key={group.identity}
                heading={
                  <span className="flex min-w-0 items-center gap-1.5">
                    <RepoBadgeMark color={group.projectBadgeColor} />
                    <span className="truncate text-[13px] font-semibold text-foreground">
                      {group.projectName}
                    </span>
                    {group.projectGroupName ? (
                      <span className="truncate text-[11px] font-normal text-muted-foreground">
                        · {group.projectGroupName}
                      </span>
                    ) : null}
                    {group.hostLabel ? (
                      <span className="ml-auto shrink-0 text-[10px] font-normal text-muted-foreground">
                        {group.hostLabel}
                      </span>
                    ) : null}
                  </span>
                }
                className="border-b border-border/60 last:border-b-0"
              >
                {group.items.map((item) => {
                  const canDelete = item.workspaceKind === 'worktree' && !item.isMainWorktree
                  const multiplexerCount = slotCountByIdentity.get(item.identity) ?? 0
                  const terminalCount = terminalCountByIdentity.get(item.identity) ?? 0
                  const activityStatus = activityStatuses.get(item.worktreeId) ?? 'inactive'
                  const workspaceStatusId = getWorkspaceStatus(item, workspaceStatuses)
                  const workspaceStatus =
                    workspaceStatuses.find((status) => status.id === workspaceStatusId) ??
                    workspaceStatusId
                  const workspaceStatusMeta = getWorkspaceStatusVisualMeta(workspaceStatus)
                  const WorkspaceStatusIcon = workspaceStatusMeta.icon
                  const deleteLabel = translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.16bc3c998a',
                    'Delete workspace {{value0}}',
                    { value0: item.workspaceName }
                  )
                  return (
                    <CommandItem
                      key={item.identity}
                      value={`${item.identity} ${item.projectGroupName ?? ''} ${item.projectName} ${item.workspaceName} ${item.branch ?? ''} ${item.path} ${item.hostLabel ?? ''}`}
                      className="jump-palette-item group/workspace ml-3 cursor-grab items-center gap-2 border-l border-border/70 py-2 pl-2.5 active:cursor-grabbing"
                      data-workspace-multiplexer-worktree-id={item.worktreeId}
                      data-terminal-tab-count={terminalCount}
                      data-workspace-activity-status={activityStatus}
                      data-workspace-status={workspaceStatusId}
                      data-review-state={item.review?.state ?? undefined}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'copy'
                        event.dataTransfer.setData(
                          'application/x-orca-workspace-multiplexer',
                          'workspace'
                        )
                        onWorkspaceDragStart(item)
                      }}
                      onDragEnd={() => {
                        onWorkspaceDragEnd()
                        setOpen(false)
                      }}
                      onSelect={() => {
                        onSelect(item)
                        setOpen(false)
                      }}
                    >
                      <StatusIndicator
                        status={activityStatus}
                        showTooltip={false}
                        aria-hidden="true"
                      />
                      <span className="sr-only">{getWorktreeStatusLabel(activityStatus)}</span>
                      {item.workspaceKind === 'folder' ? (
                        <Folder
                          className="size-3.5 shrink-0"
                          style={{ color: resolveRepoHeaderColor(item.projectBadgeColor) }}
                        />
                      ) : item.review ? (
                        <span
                          className="inline-flex size-3.5 shrink-0 items-center justify-center"
                          data-workspace-multiplexer-review-state={item.review.state}
                        >
                          <ReviewIcon review={item.review} className="size-3.5" variant="generic" />
                          <span className="sr-only">
                            {getReviewLabel(item.review)}: {reviewStateLabel(item.review.state)}
                          </span>
                        </span>
                      ) : (
                        <GitBranch
                          className="size-3.5 shrink-0"
                          style={{ color: resolveRepoHeaderColor(item.projectBadgeColor) }}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium">
                            {item.workspaceName}
                          </span>
                          {item.isMainWorktree ? (
                            <span className="shrink-0 rounded border border-border px-1 py-px text-[9px] text-muted-foreground">
                              {translate(
                                'auto.components.workspace.multiplexer.WorkspaceMultiplexerPicker.primary',
                                'primary'
                              )}
                            </span>
                          ) : null}
                          <span
                            className={cn(
                              'inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-muted/45 px-1.5 text-[10px] font-medium',
                              workspaceStatusMeta.tone
                            )}
                          >
                            <WorkspaceStatusIcon className="size-3" />
                            {typeof workspaceStatus === 'string'
                              ? workspaceStatus
                              : workspaceStatus.label}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/75">
                          {item.branch && item.branch !== item.workspaceName
                            ? `${item.branch} · ${item.path}`
                            : item.path}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                        {terminalCount > 0 ? (
                          <span
                            className="inline-flex h-5 items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 tabular-nums"
                            aria-label={
                              terminalCount === 1
                                ? translate(
                                    'auto.components.workspace.multiplexer.WorkspaceMultiplexerPicker.terminalTabs_one',
                                    '{{count}} terminal tab',
                                    { count: terminalCount }
                                  )
                                : translate(
                                    'auto.components.workspace.multiplexer.WorkspaceMultiplexerPicker.terminalTabs_other',
                                    '{{count}} terminal tabs',
                                    { count: terminalCount }
                                  )
                            }
                          >
                            <SquareTerminal className="size-3" />
                            {terminalCount}
                          </span>
                        ) : null}
                        {multiplexerCount > 0 ? (
                          <span>
                            {translate(
                              'auto.components.workspace.multiplexer.WorkspaceMultiplexerPicker.inMultiplexer',
                              '{{value0}} in Workspace Multiplexer',
                              { value0: multiplexerCount }
                            )}
                          </span>
                        ) : null}
                      </div>
                      {canDelete ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={deleteLabel}
                              data-workspace-multiplexer-delete-worktree-id={item.worktreeId}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.stopPropagation()
                                }
                              }}
                              onPointerDown={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                              }}
                              onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                handleDeleteWorktree(item)
                              }}
                              className="text-muted-foreground transition-opacity can-hover:opacity-0 group-hover/workspace:opacity-100 group-focus-within/workspace:opacity-100 group-data-[selected=true]/workspace:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100"
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" sideOffset={4}>
                            {deleteLabel}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ))}
          </CommandList>
          <div className="border-t border-border p-1">
            <Button
              type="button"
              variant="ghost"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleCreateWorktree}
              className="h-9 w-full justify-start rounded-sm px-3 text-xs font-normal"
            >
              <GitBranchPlus className="size-3.5 text-muted-foreground" />
              {translate(
                'auto.components.NewWorkspaceComposerModal.createWorktree',
                'Create worktree'
              )}
            </Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
