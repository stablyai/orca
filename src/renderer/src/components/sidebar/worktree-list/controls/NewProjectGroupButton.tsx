import React from 'react'
import { FolderTree } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

export function NewProjectGroupButton({
  preserveWorkspaceBoardOpen,
  onCreate
}: {
  preserveWorkspaceBoardOpen: boolean
  onCreate: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('auto.components.sidebar.SidebarHeader.newProjectGroup', 'New group')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          className="text-muted-foreground"
          aria-label={label}
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
          onClick={onCreate}
        >
          <FolderTree className="size-3.5" strokeWidth={2.25} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
