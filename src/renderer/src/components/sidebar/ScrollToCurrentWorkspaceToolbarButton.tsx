import { Crosshair } from 'lucide-react'
import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  getLatestScrollToCurrentWorkspaceStatus,
  requestScrollToCurrentWorkspaceReveal,
  SCROLL_TO_CURRENT_WORKSPACE_STATUS_EVENT,
  type ScrollToCurrentWorkspaceStatus
} from '@/lib/scroll-to-current-workspace-status'

export function ScrollToCurrentWorkspaceToolbarButton(): React.JSX.Element | null {
  const [status, setStatus] = useState<ScrollToCurrentWorkspaceStatus>(() =>
    getLatestScrollToCurrentWorkspaceStatus()
  )

  React.useEffect(() => {
    const handleStatus = (event: Event): void => {
      const detail = (event as CustomEvent<ScrollToCurrentWorkspaceStatus>).detail
      if (!detail) {
        return
      }
      setStatus(detail)
    }
    window.addEventListener(SCROLL_TO_CURRENT_WORKSPACE_STATUS_EVENT, handleStatus)
    return () => {
      window.removeEventListener(SCROLL_TO_CURRENT_WORKSPACE_STATUS_EVENT, handleStatus)
    }
  }, [])

  if (!status.visible) {
    return null
  }

  const button = (
    <Button
      variant="ghost"
      size="icon-xs"
      type="button"
      aria-label="Scroll to open workspace"
      disabled={status.disabled}
      onClick={status.disabled ? undefined : requestScrollToCurrentWorkspaceReveal}
      className="text-muted-foreground disabled:cursor-not-allowed disabled:opacity-55"
    >
      <Crosshair className="size-3.5" />
    </Button>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {status.disabled ? (
          <span className="inline-flex cursor-not-allowed">{button}</span>
        ) : (
          button
        )}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Scroll to open workspace
      </TooltipContent>
    </Tooltip>
  )
}
