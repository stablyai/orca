import { Bug, Kanban, ListTodo, Puzzle, Ticket, type LucideIcon } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { PluginTaskSourceAssetIcon } from '@/components/plugin-task-source-icon'
import { cn } from '@/lib/utils'
import type {
  ContributedPluginTaskSource,
  SelectedPluginTaskSource
} from '@/store/slices/plugin-task-sources-slice-contract'

/** Named one by one rather than through lucide's dynamic icon index: that
 *  import pulls every glyph into the renderer bundle and defeats tree-shaking.
 *  Growing this map is a review decision. */
const LUCIDE_ICONS: Record<string, LucideIcon | undefined> = {
  bug: Bug,
  kanban: Kanban,
  'list-todo': ListTodo,
  ticket: Ticket
}

function SourceIcon({ source }: { source: ContributedPluginTaskSource }): React.JSX.Element {
  if (source.iconDataUrl) {
    return <PluginTaskSourceAssetIcon dataUrl={source.iconDataUrl} />
  }
  const Glyph = (source.icon ? LUCIDE_ICONS[source.icon] : undefined) ?? Puzzle
  return <Glyph className="size-3.5 shrink-0" />
}

/** Contributed sources sit in their own group after the built-in options, so
 *  `taskSource` stays the closed `TaskProvider` union. */
export function TaskPagePluginSourceGroup({
  sources,
  selected,
  onSelect
}: {
  sources: ContributedPluginTaskSource[]
  selected: SelectedPluginTaskSource | null
  onSelect: (selection: SelectedPluginTaskSource) => void
}): React.JSX.Element | null {
  if (sources.length === 0) {
    return null
  }
  return (
    <>
      {sources.map((source) => {
        const active =
          selected?.pluginKey === source.pluginKey && selected.sourceId === source.sourceId
        return (
          <Tooltip key={`${source.pluginKey}:${source.sourceId}`}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  onSelect({ pluginKey: source.pluginKey, sourceId: source.sourceId })
                }}
                data-plugin-key={source.pluginKey}
                data-plugin-task-source={source.sourceId}
                aria-label={source.title}
                aria-pressed={active}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-md border transition',
                  active
                    ? 'border-foreground/40 bg-muted/70 text-foreground shadow-sm'
                    : 'border-border/40 bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                )}
              >
                <SourceIcon source={source} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {source.title}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </>
  )
}
