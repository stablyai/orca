import { useState, type ReactNode } from 'react'
import { Ellipsis } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** The `⋯` menu at the end of a hovercard reference row. */
export function WorktreeCardRowActionsMenu({
  label,
  open,
  onOpenChange,
  children
}: {
  label: string
  open?: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}): React.JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = open ?? internalOpen
  const trigger = (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-5 shrink-0"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        <Ellipsis className="size-3" />
      </Button>
    </DropdownMenuTrigger>
  )
  return (
    <DropdownMenu
      modal={false}
      open={isOpen}
      onOpenChange={(next) => {
        setInternalOpen(next)
        onOpenChange(next)
      }}
    >
      {isOpen ? (
        trigger
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {label}
          </TooltipContent>
        </Tooltip>
      )}
      <DropdownMenuContent
        align="end"
        className="w-52"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
