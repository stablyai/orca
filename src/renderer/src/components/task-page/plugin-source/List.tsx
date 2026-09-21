import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'
import type {
  PluginTaskSourceFilter,
  PluginTaskSourceLoadError,
  PluginTaskSourceQuery
} from '@/store/slices/plugin-task-sources-slice-contract'
import { PLUGIN_TASK_ROW_GRID_CLASS, TaskPagePluginSourceItemRow } from './ItemRow'
import { TaskPagePluginSourceQueryBar } from './QueryBar'
import type { PluginTaskSourceScopeFilter } from './ScopePicker'
import { groupPluginTaskItemsByState } from './state-grouping'

function ColumnHeader(): React.JSX.Element {
  const columns = [
    { id: 'key', label: translate('auto.components.TaskPage.37e7ee311e', 'Key') },
    { id: 'title', label: translate('auto.components.TaskPage.b1eaa18ace', 'Issue') },
    { id: 'state', label: translate('auto.components.TaskPage.154b0fa623', 'Status') },
    { id: 'priority', label: translate('auto.components.TaskPage.c8d5bec5f7', 'Priority') },
    {
      id: 'assignee',
      label: translate('auto.components.TaskPage.d2a876ca53', 'Assignee'),
      className: 'max-lg:!hidden'
    },
    { id: 'updated', label: translate('auto.components.TaskPage.f362667d55', 'Updated') }
  ]
  return (
    <div
      className={cn(
        'grid h-8 flex-none items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase max-md:!hidden',
        PLUGIN_TASK_ROW_GRID_CLASS
      )}
    >
      {columns.map((column) => (
        <span key={column.id} className={cn('truncate', column.className)}>
          {column.label}
        </span>
      ))}
      <span />
    </div>
  )
}

function LoadingRows(): React.JSX.Element {
  return (
    <div className="divide-y divide-border/50">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="px-3 py-3">
          <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
          <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
        </div>
      ))}
    </div>
  )
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium text-foreground">
        {translate('auto.components.TaskPage.pluginTaskSourceEmpty', 'No tasks found')}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        {translate(
          'auto.components.TaskPage.pluginTaskSourceEmptyHint',
          'This source returned no items.'
        )}
      </p>
    </div>
  )
}

function StateSections({
  items,
  onUseItem
}: {
  items: PluginTaskItem[]
  onUseItem: (item: PluginTaskItem) => void
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const sections = useMemo(() => groupPluginTaskItemsByState(items), [items])

  return (
    <div className="divide-y divide-border/50">
      {sections.map((section) => {
        const open = !collapsed.has(section.key)
        return (
          <Collapsible
            key={section.key}
            open={open}
            onOpenChange={(nextOpen) => {
              setCollapsed((current) => {
                const next = new Set(current)
                if (nextOpen) {
                  next.delete(section.key)
                } else {
                  next.add(section.key)
                }
                return next
              })
            }}
          >
            {/* A plain button, not the Button primitive: this is a full-width
                table band, a shape no Button size or variant carries. */}
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 bg-muted/35 px-3 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
              >
                {open ? (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                  {section.label}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {section.items.length}
                </span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="divide-y divide-border/50 border-t border-border/50">
                {section.items.map((item) => (
                  <TaskPagePluginSourceItemRow key={item.id} item={item} onUseItem={onUseItem} />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}

export function TaskPagePluginSourceList({
  title,
  items,
  loading,
  error,
  filters,
  query,
  onQueryChange,
  scopeFilter,
  onUseItem
}: {
  title: string
  items: PluginTaskItem[]
  loading: boolean
  error: PluginTaskSourceLoadError | null
  filters: PluginTaskSourceFilter[]
  query: PluginTaskSourceQuery
  onQueryChange: (query: PluginTaskSourceQuery) => void
  scopeFilter: PluginTaskSourceScopeFilter
  onUseItem: (item: PluginTaskItem) => void
}): React.JSX.Element {
  return (
    <div className="mt-2 flex max-h-full min-h-0 flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
      <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
        <div className="min-w-0 truncate text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
          {title}
        </div>
        <div className="shrink-0 text-[11px] text-muted-foreground">
          {items.length} {translate('auto.components.TaskPage.b7bae28b6a', 'shown')}
        </div>
      </div>

      <TaskPagePluginSourceQueryBar
        filters={filters}
        query={query}
        onQueryChange={onQueryChange}
        scopeFilter={scopeFilter}
      />

      <ColumnHeader />

      <div
        className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
        style={{ scrollbarGutter: 'stable' }}
      >
        {error ? (
          <div role="alert" className="border-b border-border px-4 py-4 text-sm text-destructive">
            {error.message}
          </div>
        ) : null}

        {loading && items.length === 0 ? <LoadingRows /> : null}

        {/* An error must never read as an empty board — that distinction is the
            whole point of the source's error taxonomy. */}
        {!loading && !error && items.length === 0 ? <EmptyState /> : null}

        <StateSections items={items} onUseItem={onUseItem} />
      </div>
    </div>
  )
}
