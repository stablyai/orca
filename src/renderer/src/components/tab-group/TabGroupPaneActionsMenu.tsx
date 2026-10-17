import { Ellipsis, X } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

const TRIGGER_CLASS_NAME =
  'my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

/** The focused split pane's "…" menu on the tab strip. */
export function TabGroupPaneActionsMenu({
  onCloseGroup
}: {
  onCloseGroup: () => void
}): React.JSX.Element {
  const label = translate('auto.components.tab.group.TabGroupPanel.9acaf92093', 'Pane Actions')
  return (
    <Tooltip>
      <DropdownMenu modal={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={label}
              onClick={(event) => {
                event.stopPropagation()
              }}
              className={TRIGGER_CLASS_NAME}
            >
              <Ellipsis className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
          <DropdownMenuItem variant="destructive" onSelect={onCloseGroup}>
            <X className="size-4" />
            {translate(
              'auto.components.tab.group.TabGroupPanel.closePaneColumn',
              'Close split pane'
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
