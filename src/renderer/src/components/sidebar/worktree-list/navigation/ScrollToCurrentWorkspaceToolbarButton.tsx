import { Crosshair } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { requestScrollToCurrentWorkspaceReveal } from '@/lib/scroll-to-current-workspace-status'
import { useTranslate } from '@/i18n/use-translate'

export function ScrollToCurrentWorkspaceToolbarButton(): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          aria-label={t(
            'auto.components.sidebar.ScrollToCurrentWorkspaceToolbarButton.23989bb663',
            'Reveal active workspace'
          )}
          onClick={requestScrollToCurrentWorkspaceReveal}
          className="text-muted-foreground"
        >
          <Crosshair className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {t(
          'auto.components.sidebar.ScrollToCurrentWorkspaceToolbarButton.23989bb663',
          'Reveal active workspace'
        )}
      </TooltipContent>
    </Tooltip>
  )
}
