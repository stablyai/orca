import { X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function BrowserNewTabTile({
  icon,
  label,
  tooltip,
  onOpen,
  onRemove,
  removeLabel
}: {
  icon: React.ReactNode
  label: string
  tooltip: string
  onOpen: () => void
  onRemove?: () => void
  removeLabel?: string
}): React.JSX.Element {
  return (
    <div className="group/tile relative min-w-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            className="flex w-full min-w-0 flex-col items-center gap-2 rounded-xl px-1.5 pt-3.5 pb-2.5 outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <span className="grid size-12 place-items-center rounded-xl border border-border bg-muted">
              {icon}
            </span>
            <span className="max-w-full truncate text-xs text-foreground">{label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {tooltip}
        </TooltipContent>
      </Tooltip>
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="absolute top-1 right-1 grid size-5 place-items-center rounded-full border border-border bg-popover text-muted-foreground opacity-0 outline-none group-hover/tile:opacity-100 group-focus-within/tile:opacity-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  )
}
