import { translate } from '@/i18n/i18n'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'
import type { PluginTaskSourceLoadError } from '@/store/slices/plugin-task-sources-slice-contract'

export function TaskPagePluginSourceList({
  title,
  items,
  loading,
  error,
  onUseItem
}: {
  title: string
  items: PluginTaskItem[]
  loading: boolean
  error: PluginTaskSourceLoadError | null
  onUseItem: (item: PluginTaskItem) => void
}): React.JSX.Element {
  return (
    <div className="mt-2 flex min-h-0 max-h-full flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
      <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
        <div className="min-w-0 truncate text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {title}
        </div>
        <div className="shrink-0 text-[11px] text-muted-foreground">
          {items.length} {translate('auto.components.TaskPage.b7bae28b6a', 'shown')}
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
        style={{
          scrollbarGutter: 'stable'
        }}
      >
        {error ? (
          <div role="alert" className="border-b border-border px-4 py-4 text-sm text-destructive">
            {error.message}
          </div>
        ) : null}

        {loading && items.length === 0 ? (
          <div className="divide-y divide-border/50">
            {Array.from({
              length: 6
            }).map((_, i) => (
              <div key={i} className="px-3 py-3">
                <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
              </div>
            ))}
          </div>
        ) : null}

        {/* An error must never read as an empty board — that distinction is the
            whole point of the source's error taxonomy. */}
        {!loading && !error && items.length === 0 ? (
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
        ) : null}

        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onUseItem(item)}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/50 px-3 py-2 text-left transition last:border-b-0 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {item.key}
              </span>
              <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                {item.title}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center rounded-full border border-border/60 px-1.5 py-0.5 font-medium">
                {item.state.name}
              </span>
              <span className="max-w-32 truncate">
                {item.assignee?.displayName ??
                  translate('auto.components.TaskPage.pluginTaskSourceUnassigned', 'Unassigned')}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
