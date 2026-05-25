import { Crosshair } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { requestScrollToCurrentWorkspaceReveal } from '@/lib/scroll-to-current-workspace-status'

export function ScrollToCurrentWorkspaceToolbarButton(): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          aria-label="Scroll to open workspace"
          onClick={requestScrollToCurrentWorkspaceReveal}
          className="text-muted-foreground"
        >
          <Crosshair className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Scroll to open workspace
      </TooltipContent>
    </Tooltip>
  )
}
