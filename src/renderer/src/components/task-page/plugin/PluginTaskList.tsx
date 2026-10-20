import type React from 'react'
import { ArrowRight, ExternalLink, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source'
import type { Worktree } from '../../../../../shared/worktree/types'
import { formatRelativeTime } from '../../task-page-source-context'
import { getPluginTaskStatusTone } from './plugin-task-status-tone'

const ROW_GRID =
  'grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_132px_56px_96px_64px] lg:grid-cols-[minmax(0,1.4fr)_144px_56px_200px_104px_64px]'

function formatUpdatedAt(value: string | undefined): string {
  if (!value || Number.isNaN(Date.parse(value))) {
    return value ?? ''
  }
  return formatRelativeTime(value)
}

function PluginTaskStatusBadge({ item }: { item: PluginTaskItem }): React.JSX.Element | null {
  if (!item.status) {
    return null
  }
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        getPluginTaskStatusTone(item.status.tone)
      )}
    >
      <span className="truncate">{item.status.label}</span>
    </span>
  )
}

/** Workspaces already started from this task; opens the first, the tooltip names the rest. */
export function PluginTaskWorkspaceChip({
  workspaces,
  onOpenWorkspace
}: {
  workspaces: readonly Worktree[]
  onOpenWorkspace: (worktreeId: string) => void
}): React.JSX.Element | null {
  const first = workspaces[0]
  if (!first) {
    return null
  }
  const names = workspaces.map((workspace) => workspace.displayName).join(', ')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onOpenWorkspace(first.id)
          }}
          className="inline-flex max-w-[220px] shrink-0 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={translate(
            'auto.components.TaskPage.pluginTaskOpenWorkspace',
            'Open workspace {{value0}}',
            { value0: first.displayName }
          )}
        >
          <SquareTerminal className="size-3 shrink-0" />
          <span className="truncate">{first.displayName}</span>
          {workspaces.length > 1 ? <span>+{workspaces.length - 1}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {translate('auto.components.TaskPage.pluginTaskWorkspaces', 'Workspaces: {{value0}}', {
          value0: names
        })}
      </TooltipContent>
    </Tooltip>
  )
}

export function PluginTaskStartButton({
  item,
  hasWorkspaces,
  onStart
}: {
  item: PluginTaskItem
  hasWorkspaces: boolean
  onStart: (item: PluginTaskItem) => void
}): React.JSX.Element {
  const label = item.start
    ? hasWorkspaces
      ? translate('auto.components.TaskPage.pluginTaskStartAnother', 'Start another workspace')
      : translate('auto.components.TaskPage.9497f2787c', 'Start workspace')
    : (item.startBlockedReason ??
      translate(
        'auto.components.TaskPage.pluginTaskNotStartable',
        'This task cannot start a workspace'
      ))
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Why: a disabled button swallows hover, so the span keeps the reason reachable. */}
        <span tabIndex={item.start ? undefined : 0}>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={!item.start}
            onClick={(event) => {
              event.stopPropagation()
              onStart(item)
            }}
            aria-label={label}
          >
            <ArrowRight className="size-3.5" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function PluginTaskRow({
  item,
  selected,
  workspaces,
  onOpen,
  onStart,
  onOpenWorkspace
}: {
  item: PluginTaskItem
  selected: boolean
  workspaces: readonly Worktree[]
  onOpen: (item: PluginTaskItem) => void
  onStart: (item: PluginTaskItem) => void
  onOpenWorkspace: (worktreeId: string) => void
}): React.JSX.Element {
  const labels = (item.labels ?? []).slice(0, 3)
  const hiddenLabelCount = (item.labels?.length ?? 0) - labels.length
  return (
    // Why: the row contains action buttons, so a native button wrapper would
    // create invalid nested buttons; role + keyboard handling preserves access.
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      data-current={selected ? 'true' : undefined}
      onClick={() => onOpen(item)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(item)
        }
      }}
      className={cn(
        'group/row grid min-h-12 cursor-pointer items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        ROW_GRID,
        selected && 'bg-accent'
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">{item.title}</h3>
          <PluginTaskWorkspaceChip workspaces={workspaces} onOpenWorkspace={onOpenWorkspace} />
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 md:!hidden">
          <PluginTaskStatusBadge item={item} />
          {item.priority ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">{item.priority}</span>
          ) : null}
        </div>
        {item.summary || labels.length > 0 ? (
          <div className="mt-1 flex min-w-0 items-center gap-1 max-md:!hidden">
            {labels.map((label) => (
              <span
                key={label}
                className="max-w-[140px] shrink-0 truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {label}
              </span>
            ))}
            {hiddenLabelCount > 0 ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                +{hiddenLabelCount}
              </span>
            ) : null}
            {item.summary ? (
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {item.summary}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 max-md:!hidden">
        <PluginTaskStatusBadge item={item} />
      </div>

      <span className="block truncate text-[12px] text-muted-foreground max-md:!hidden">
        {item.priority ?? ''}
      </span>

      <span className="block truncate text-[12px] text-muted-foreground max-lg:!hidden">
        {item.owner ?? ''}
      </span>

      <span className="block truncate text-[12px] text-muted-foreground max-md:!hidden">
        {formatUpdatedAt(item.updatedAt)}
      </span>

      <div className="flex shrink-0 items-center justify-end gap-1 md:opacity-0 md:transition-opacity md:group-hover/row:opacity-100 md:group-focus-within/row:opacity-100">
        <PluginTaskStartButton
          item={item}
          hasWorkspaces={workspaces.length > 0}
          onStart={onStart}
        />
        {item.url ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(event) => {
                  event.stopPropagation()
                  if (item.url) {
                    void window.api.shell.openUrl(item.url)
                  }
                }}
                aria-label={translate('auto.components.TaskPage.pluginTaskOpenLink', 'Open link')}
              >
                <ExternalLink className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.TaskPage.pluginTaskOpenLink', 'Open link')}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

export function PluginTaskList({
  items,
  selectedItemId,
  workspacesFor,
  onOpen,
  onStart,
  onOpenWorkspace
}: {
  items: readonly PluginTaskItem[]
  selectedItemId: string | null
  workspacesFor: (itemId: string) => readonly Worktree[]
  onOpen: (item: PluginTaskItem) => void
  onStart: (item: PluginTaskItem) => void
  onOpenWorkspace: (worktreeId: string) => void
}): React.JSX.Element {
  return (
    <div className="divide-y divide-border/50">
      {items.map((item) => (
        <PluginTaskRow
          key={item.id}
          item={item}
          selected={item.id === selectedItemId}
          workspaces={workspacesFor(item.id)}
          onOpen={onOpen}
          onStart={onStart}
          onOpenWorkspace={onOpenWorkspace}
        />
      ))}
    </div>
  )
}
