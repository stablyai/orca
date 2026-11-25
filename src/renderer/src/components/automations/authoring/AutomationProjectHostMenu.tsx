import { Check, ChevronRight } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Repo } from '../../../../../shared/repository/repo-types'

type AutomationProjectHostMenuProps = {
  sources: readonly Repo[]
  selectedSourceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onHoverChange: (hovered: boolean) => void
  hostLabelOf: (source: Repo) => string
  onSelect: (repoId: string) => void
}

/** The hosts one project is on, for a project open on several. */
export function AutomationProjectHostMenu({
  sources,
  selectedSourceId,
  open,
  onOpenChange,
  onHoverChange,
  hostLabelOf,
  onSelect
}: AutomationProjectHostMenuProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t(
            'auto.components.automations.AutomationProjectCombobox.chooseHost',
            'Choose automation host'
          )}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onMouseDown={(event) => event.preventDefault()}
          className="flex w-7 shrink-0 items-center justify-center text-muted-foreground"
        >
          <ChevronRight className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={6}
        className="w-[min(260px,calc(100vw-1rem))] p-1"
        onMouseEnter={() => onHoverChange(true)}
        onMouseLeave={() => onHoverChange(false)}
      >
        <div className="py-1">
          {sources.map((source) => (
            <button
              key={source.id}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(source.id)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Check
                className={cn(
                  'size-3 text-muted-foreground',
                  source.id === selectedSourceId ? 'opacity-70' : 'opacity-0'
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs">{hostLabelOf(source)}</div>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{source.path}</p>
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
