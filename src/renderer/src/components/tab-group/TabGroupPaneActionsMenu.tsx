import { useState } from 'react'
import { Ellipsis, X } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

type TabGroupPaneActionsMenuProps = {
  isFocused: boolean
  onCloseGroup: () => void
}

export function TabGroupPaneActionsMenu({
  isFocused,
  onCloseGroup
}: TabGroupPaneActionsMenuProps): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  // Why: the strip stays mounted when focus or the workspace moves away; close so it can't act on a stale group.
  if (!isFocused && open) {
    setOpen(false)
  }

  return (
    <Tooltip>
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('auto.components.tab.group.TabGroupPanel.9acaf92093', 'Pane Actions')}
              onClick={(event) => {
                event.stopPropagation()
              }}
              className="my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Ellipsis className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <DropdownMenuContent
          align="end"
          side="bottom"
          sideOffset={4}
          onCloseAutoFocus={(event) => {
            if (!isFocused) {
              event.preventDefault()
            }
          }}
        >
          <DropdownMenuItem variant="destructive" onSelect={() => onCloseGroup()}>
            <X className="size-4" />
            {t('auto.components.tab.group.TabGroupPanel.closePaneColumn', 'Close split pane')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TooltipContent side="bottom" sideOffset={6}>
        {t('auto.components.tab.group.TabGroupPanel.9acaf92093', 'Pane Actions')}
      </TooltipContent>
    </Tooltip>
  )
}
