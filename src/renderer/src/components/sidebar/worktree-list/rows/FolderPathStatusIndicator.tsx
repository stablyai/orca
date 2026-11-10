import React from 'react'
import { FolderX } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import {
  getFolderWorkspacePathStatusDescription,
  getFolderWorkspacePathStatusTitle
} from '@/lib/workspace/paths/folder-workspace-path-status'
import {
  isConfirmedStaleFolderPathStatus,
  type FolderWorkspacePathStatus
} from '../../../../../../shared/folder-workspaces/folder-workspace-path-status'
import { useTranslate } from '@/i18n/use-translate'

export function FolderPathStatusIndicator({
  status
}: {
  status: FolderWorkspacePathStatus | null | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const title = getFolderWorkspacePathStatusTitle(status, t)
  if (!status || status.exists || !title) {
    return null
  }
  const destructive = isConfirmedStaleFolderPathStatus(status)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px]',
            destructive ? 'text-destructive' : 'text-muted-foreground'
          )}
          aria-label={title}
        >
          <FolderX className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
        <div className="space-y-1">
          <div className="font-medium">{title}</div>
          <div className="text-muted-foreground">
            {getFolderWorkspacePathStatusDescription(status, t)}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
