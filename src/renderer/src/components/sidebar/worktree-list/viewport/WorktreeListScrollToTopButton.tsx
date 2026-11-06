import { ChevronsUp } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export function WorktreeListScrollToTopButton({
  onClick,
  className
}: {
  onClick: () => void
  className?: string
}): React.JSX.Element {
  const label = translate(
    'auto.components.sidebar.WorktreeListScrollToTopButton.jumpToTop',
    'Jump to top'
  )

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 top-2 z-40 flex justify-center',
        className
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={onClick}
            className={cn(
              'pointer-events-auto size-6 text-muted-foreground',
              'hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground',
              'animate-in fade-in-0 duration-150 motion-reduce:animate-none'
            )}
          >
            <ChevronsUp className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
