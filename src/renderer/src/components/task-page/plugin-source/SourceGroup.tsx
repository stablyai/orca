import { Puzzle } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type {
  ContributedPluginTaskSource,
  SelectedPluginTaskSource
} from '@/store/slices/plugin-task-sources-slice-contract'

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
      <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
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
                aria-pressed={active}
                className={cn(
                  'flex h-8 max-w-40 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition',
                  active
                    ? 'border-foreground/40 bg-muted/70 text-foreground shadow-sm'
                    : 'border-border/40 bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                )}
              >
                <Puzzle className="size-3.5 shrink-0" />
                <span className="truncate">{source.title}</span>
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
