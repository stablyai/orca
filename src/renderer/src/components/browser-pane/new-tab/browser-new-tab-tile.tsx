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
            className="flex h-24 w-full min-w-0 flex-col items-center justify-center gap-3 rounded-2xl px-2 @md:h-28 @md:gap-3.5 outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            {icon}
            <span className="max-w-full truncate text-sm text-foreground">{label}</span>
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
          className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full border border-border bg-popover text-muted-foreground opacity-0 outline-none group-hover/tile:opacity-100 group-focus-within/tile:opacity-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  )
}
