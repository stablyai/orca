// Why: shared segmented preset row for provider toolbars (Jira, GitLab, Linear) so
// active-pill styling and pressed semantics stay identical across providers.
import React from 'react'
import { cn } from '@/lib/utils'

type TaskPresetButtonsProps<Id extends string> = {
  presets: readonly { id: Id; label: string }[]
  activeId: Id | null
  onSelect: (id: Id) => void
  ariaLabel?: string
  className?: string
}

export function TaskPresetButtons<Id extends string>({
  presets,
  activeId,
  onSelect,
  ariaLabel,
  className
}: TaskPresetButtonsProps<Id>): React.JSX.Element {
  return (
    <div className={cn('flex flex-wrap gap-2', className)} role="group" aria-label={ariaLabel}>
      {presets.map((preset) => {
        const active = preset.id === activeId
        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(preset.id)}
            className={cn(
              'rounded-md border px-2 py-1 text-xs transition',
              active
                ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
            )}
          >
            {preset.label}
          </button>
        )
      })}
    </div>
  )
}
