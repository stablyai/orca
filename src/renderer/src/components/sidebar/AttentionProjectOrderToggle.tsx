import React from 'react'
import { ArrowDownWideNarrow } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export function AttentionProjectOrderToggle(): React.JSX.Element {
  const active = useAppStore((s) => s.projectOrderBy === 'attention')
  const toggleAttentionProjectOrder = useAppStore((s) => s.toggleAttentionProjectOrder)
  // Why both effects in the copy: the toggle also switches on one row per project.
  const label = active
    ? translate(
        'auto.components.sidebar.SidebarHeader.restoreProjectList',
        'Restore previous project list'
      )
    : translate(
        'auto.components.sidebar.SidebarHeader.compactProjectsByAttention',
        'Compact projects, sorted by attention'
      )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? 'secondary' : 'ghost'}
          size="icon-xs"
          aria-label={label}
          aria-pressed={active}
          onClick={(event) => {
            toggleAttentionProjectOrder()
            // Why: a mouse click left focus on the button, so window refocus (Cmd+Tab) reopened the tooltip.
            if (event.detail > 0) {
              event.currentTarget.blur()
            }
          }}
        >
          {/* Why on the icon: Button owns its color; idle matches the muted header icons beside it. */}
          <ArrowDownWideNarrow
            className={cn('size-3.5', !active && 'text-muted-foreground')}
            strokeWidth={2.25}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
