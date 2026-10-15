import type React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** One icon tab in the Tasks source bar (built-in providers and plugin sources). */
export function TaskPageSourceIconButton({
  label,
  active,
  disabled = false,
  dataTaskSource,
  onSelect,
  children
}: {
  label: string
  active: boolean
  disabled?: boolean
  dataTaskSource: string
  onSelect: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={onSelect}
          data-task-source={dataTaskSource}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            'group flex h-8 w-8 items-center justify-center rounded-md border transition',
            active
              ? 'border-foreground/40 bg-muted/70 text-foreground shadow-sm'
              : 'border-border/40 bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground',
            disabled && 'cursor-not-allowed opacity-55'
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
