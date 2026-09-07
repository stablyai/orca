import { MoreHorizontal } from 'lucide-react'
import { Button } from '../ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu'
import { WorkspaceLayoutMenuItems } from './WorkspaceLayoutMenuItems'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function WorkspaceWindowMenu({ paneId }: { paneId: string }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button aria-label="Window actions" variant="ghost" size="icon-xs">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Window actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <WorkspaceLayoutMenuItems paneId={paneId} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
