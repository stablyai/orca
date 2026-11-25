import { useRef, useState, type RefObject } from 'react'
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
import { useNativeChatQuickCommandsMenu } from '../../native-chat/pane/actions/use-native-chat-quick-commands-menu'
import { focusStripActionsReturnTarget } from './strip-actions-return-focus'
import { isGroupFocusedInStore } from './is-group-focused-in-store'

type TabGroupPaneActionsMenuProps = {
  isFocused: boolean
  onCloseGroup: () => void
  worktreeId: string
  groupId: string
  /** The strip's quick-command slot; when a narrow strip hides it, this menu offers quick commands instead. */
  quickCommandsSlotRef: RefObject<HTMLElement | null>
}

function isSlotHidden(slot: HTMLElement | null): boolean {
  return Boolean(
    slot && slot.childElementCount > 0 && getComputedStyle(slot).visibility === 'hidden'
  )
}

export function TabGroupPaneActionsMenu({
  isFocused,
  onCloseGroup,
  worktreeId,
  groupId,
  quickCommandsSlotRef
}: TabGroupPaneActionsMenuProps): React.JSX.Element {
  const t = useTranslate()
  const closeLabel = t(
    'auto.components.tab.group.TabGroupPanel.closePaneColumn',
    'Close split pane'
  )
  const [open, setOpen] = useState(false)
  const [offerQuickCommands, setOfferQuickCommands] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dismissedOutsideRef = useRef(false)
  const quickCommands = useNativeChatQuickCommandsMenu(
    offerQuickCommands ? { worktreeId, groupId } : undefined,
    () => setOpen(false),
    (event) => {
      // The menu row that opened the editor is gone, so Radix would drop focus on body.
      event.preventDefault()
      requestAnimationFrame(() =>
        focusStripActionsReturnTarget({
          trigger: triggerRef.current,
          fallback: closeButtonRef.current,
          stillOwned: () => isGroupFocusedInStore(worktreeId, groupId)
        })
      )
    }
  )
  const handleOpenChange = (next: boolean): void => {
    // Why: the menu renders in a portal, so check the strip's container-query result when it opens.
    if (next) {
      dismissedOutsideRef.current = false
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
      {/* Why: ⋯ holds only Close while the inline quick-command button shows, so show Close directly, with its label where Command shows one; widths mirror that slot's thresholds. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={closeButtonRef}
            type="button"
            data-pane-close-trigger=""
            aria-label={closeLabel}
            onClick={(event) => {
              event.stopPropagation()
              onCloseGroup()
            }}
            className="my-auto flex h-7 w-7 shrink-0 items-center justify-center gap-1 rounded-md text-muted-foreground hover:bg-accent/50 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent @min-[481px]/tab-strip:w-auto @min-[481px]/tab-strip:px-1.5 @max-[163px]/tab-strip:hidden group-has-[[data-pinned-home-with-strip]]/tab-strip-row:@max-[203px]/tab-strip:hidden"
          >
            <X className="size-4 @min-[481px]/tab-strip:size-3.5" />
            <span className="text-[12px] font-medium @max-[480px]/tab-strip:hidden">
              {closeLabel}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {closeLabel}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                data-pane-actions-menu-trigger=""
                aria-label={t('auto.components.tab.group.TabGroupPanel.9acaf92093', 'Pane Actions')}
                onClick={(event) => {
                  event.stopPropagation()
                }}
                className="my-auto hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent @max-[163px]/tab-strip:flex group-has-[[data-pinned-home-with-strip]]/tab-strip-row:@max-[203px]/tab-strip:flex"
              >
                <Ellipsis className="size-4" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <DropdownMenuContent
            align="end"
            side="bottom"
            sideOffset={4}
            onInteractOutside={() => {
              dismissedOutsideRef.current = true
            }}
            onCloseAutoFocus={(event) => {
              const dismissedOutside = dismissedOutsideRef.current
              dismissedOutsideRef.current = false
              if (!isFocused) {
                event.preventDefault()
                return
              }
              // Why: widening the strip hides ⋯ under an open menu, and a hidden trigger can't take the restored focus; a click elsewhere keeps the focus it just moved.
              const close = closeButtonRef.current
              if (
                !dismissedOutside &&
                triggerRef.current?.offsetParent === null &&
                close?.offsetParent
              ) {
                event.preventDefault()
                close.focus()
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
              {closeLabel}
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
