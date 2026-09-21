import { ArrowRight, ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { getAssigneeAvatarTone } from '@/lib/assignee-avatar-tone'
import { cn } from '@/lib/utils'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'
import { formatRelativeTime } from '../../task-page-source-context'
import { getPluginTaskStateTone } from './task-state-tone'

/** Shared by the row and the column header so the two stay in one grid. */
export const PLUGIN_TASK_ROW_GRID_CLASS =
  'grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[90px_minmax(0,1fr)_128px_92px_80px_64px] lg:grid-cols-[96px_minmax(0,1.25fr)_132px_120px_136px_96px_64px] xl:grid-cols-[104px_minmax(0,1.45fr)_144px_132px_160px_128px_72px]'

const VISIBLE_LABELS = 3

/** "David Mugisha" -> "DM"; single word -> its first letter; empty/whitespace -> "-". */
function getAssigneeInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return '-'
  }
  if (words.length === 1) {
    return words[0].slice(0, 1).toUpperCase()
  }
  return `${words[0].slice(0, 1)}${words.at(-1)?.slice(0, 1) ?? ''}`.toUpperCase()
}

function AssigneeAvatar({ assignee }: { assignee: PluginTaskItem['assignee'] }): React.JSX.Element {
  // Some providers (e.g. Azure Boards) send auth-gated avatar URLs the renderer
  // can never load; fall back to initials on load failure, not just when absent.
  const [imageFailed, setImageFailed] = useState(false)
  const displayName = assignee?.displayName ?? ''

  if (assignee?.avatarUrl && !imageFailed) {
    return (
      <img
        src={assignee.avatarUrl}
        alt={displayName}
        className="size-5 shrink-0 rounded-full"
        onError={() => setImageFailed(true)}
      />
    )
  }

  return (
    <span
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full border border-border/50 text-[10px]',
        getAssigneeAvatarTone(assignee)
      )}
    >
      {getAssigneeInitials(displayName)}
    </span>
  )
}

function AssigneeCell({ item }: { item: PluginTaskItem }): React.JSX.Element {
  const unassigned = translate('auto.components.TaskPage.pluginTaskSourceUnassigned', 'Unassigned')
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground max-lg:!hidden">
      <AssigneeAvatar assignee={item.assignee} />
      <span className="truncate">{item.assignee?.displayName ?? unassigned}</span>
    </div>
  )
}

function UpdatedCell({ updatedAt }: { updatedAt: string | null }): React.JSX.Element {
  if (!updatedAt) {
    return <span className="block min-w-0 text-[12px] text-muted-foreground max-md:!hidden" />
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="block min-w-0 truncate text-[12px] text-muted-foreground max-md:!hidden">
          {formatRelativeTime(updatedAt)}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {new Date(updatedAt).toLocaleString()}
      </TooltipContent>
    </Tooltip>
  )
}

function RowActions({
  item,
  onUseItem
}: {
  item: PluginTaskItem
  onUseItem: (item: PluginTaskItem) => void
}): React.JSX.Element {
  const startLabel = translate(
    'auto.components.TaskPage.ff90d0abc7',
    'Start workspace from {{value0}}',
    { value0: item.key }
  )
  const openLabel = translate('auto.components.TaskPage.pluginTaskSourceOpen', 'Open {{value0}}', {
    value0: item.key
  })
  const url = item.url
  return (
    <div className="flex shrink-0 items-center justify-end gap-1 md:opacity-0 md:transition-opacity md:group-focus-within/row:opacity-100 md:group-hover/row:opacity-100">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={startLabel}
            onClick={(event) => {
              event.stopPropagation()
              onUseItem(item)
            }}
          >
            <ArrowRight className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('auto.components.TaskPage.9497f2787c', 'Start workspace')}
        </TooltipContent>
      </Tooltip>
      {url ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={openLabel}
              onClick={(event) => {
                event.stopPropagation()
                window.api.shell.openUrl(url)
              }}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {openLabel}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

export function TaskPagePluginSourceItemRow({
  item,
  onOpenItem,
  onUseItem
}: {
  item: PluginTaskItem
  /** Row click and keyboard activation: opens the read-only detail panel. */
  onOpenItem: (item: PluginTaskItem) => void
  onUseItem: (item: PluginTaskItem) => void
}): React.JSX.Element {
  const labels = item.labels ?? []
  const shownLabels = labels.slice(0, VISIBLE_LABELS)
  const tone = getPluginTaskStateTone(item.state.category)

  return (
    // Why: the row carries its own action buttons, so a native button wrapper
    // would nest buttons; role + keyboard handling keeps it operable.
    <div
      role="button"
      tabIndex={0}
      aria-label={`${item.key} ${item.title}`}
      onClick={() => onOpenItem(item)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenItem(item)
        }
      }}
      className={cn(
        'group/row grid min-h-12 cursor-pointer items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
        PLUGIN_TASK_ROW_GRID_CLASS
      )}
    >
      <span className="block truncate font-mono text-[12px] text-muted-foreground max-md:!hidden">
        {item.key}
      </span>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground md:hidden">
            {item.key}
          </span>
          <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">{item.title}</h3>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 md:!hidden">
          <span
            className={cn(
              'inline-flex min-w-0 items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium',
              tone
            )}
          >
            <span className="truncate">{item.state.name}</span>
          </span>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {item.assignee?.displayName ??
              translate('auto.components.TaskPage.pluginTaskSourceUnassigned', 'Unassigned')}
          </span>
        </div>
        {shownLabels.length > 0 ? (
          <div className="mt-1 flex min-w-0 items-center gap-1">
            {shownLabels.map((label) => (
              <span
                key={label}
                className="max-w-[140px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {label}
              </span>
            ))}
            {labels.length > shownLabels.length ? (
              <span className="text-[10px] text-muted-foreground">
                +{labels.length - shownLabels.length}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 max-md:!hidden">
        <span
          className={cn(
            'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
            tone
          )}
        >
          <span className="truncate">{item.state.name}</span>
        </span>
      </div>

      <span className="block truncate text-[12px] text-muted-foreground max-md:!hidden">
        {item.priority ?? ''}
      </span>

      <AssigneeCell item={item} />

      <UpdatedCell updatedAt={item.updatedAt} />

      <RowActions item={item} onUseItem={onUseItem} />
    </div>
  )
}
