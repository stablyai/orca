import { useState, type RefObject } from 'react'
import { Ellipsis, X } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useNativeChatQuickCommandsMenu } from '../native-chat/pane/actions/use-native-chat-quick-commands-menu'

type TabGroupPaneActionsMenuProps = {
  isFocused: boolean
  onCloseGroup: () => void
  worktreeId: string
  groupId: string
  /** The strip's quick-command slot; when a narrow strip hides it, this menu offers quick commands instead. */
  quickCommandsSlotRef: RefObject<HTMLElement | null>
}

function isSlotHidden(slot: HTMLElement | null): boolean {
  return Boolean(slot && slot.childElementCount > 0 && getComputedStyle(slot).display === 'none')
}

export function TabGroupPaneActionsMenu({
  isFocused,
  onCloseGroup,
  worktreeId,
  groupId,
  quickCommandsSlotRef
}: TabGroupPaneActionsMenuProps): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [offerQuickCommands, setOfferQuickCommands] = useState(false)
  const quickCommands = useNativeChatQuickCommandsMenu(
    offerQuickCommands ? { worktreeId, groupId } : undefined,
    () => setOpen(false)
  )
  const handleOpenChange = (next: boolean): void => {
    // Why: the menu renders in a portal, so check the strip's container-query result when it opens.
    if (next) {
      setOfferQuickCommands(isSlotHidden(quickCommandsSlotRef.current))
    }
    setOpen(next)
  }
  // Why: the strip stays mounted when focus or the workspace moves away; close so it can't act on a stale group.
  if (!isFocused && open) {
    setOpen(false)
  }

  return (
    <>
      <Tooltip>
        <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
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
            {quickCommands.menu ? (
              <>
                {quickCommands.menu}
                <DropdownMenuSeparator />
              </>
            ) : null}
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
      {quickCommands.dialog}
    </>
  )
}
