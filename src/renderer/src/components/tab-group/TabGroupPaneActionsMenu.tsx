import { useRef, useState, type RefObject } from 'react'
import { ArrowLeft, ArrowRight, Ellipsis, Plus, X } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useNativeChatQuickCommandsMenu } from '../native-chat/pane/actions/use-native-chat-quick-commands-menu'
import { useAppStore } from '../../store'
import {
  canGoBackWorktreeHistory,
  canGoForwardWorktreeHistory
} from '@/store/slices/ui/workspace-navigation-history'
import { runBuiltInOrReplacement } from '@/lib/plugins/commands/plugin-command-replacements'
import { useShortcutLabel } from '../../hooks/useShortcutLabel'
import type { TitlebarChromeFoldLevel } from '@/app-shell/chrome/titlebar-chrome-fold'
import { captureFocusBeforeRestore, restoreTabStripFocus } from '../tab-bar/tab-strip-focus-restore'

type TabGroupPaneActionsMenuProps = {
  isFocused: boolean
  /** Only split groups can close their pane. */
  onCloseGroup?: () => void
  worktreeId: string
  groupId: string
  /** The strip's quick-command slot; when a narrow strip hides it, this menu offers quick commands instead. */
  quickCommandsSlotRef: RefObject<HTMLElement | null>
  /** Titlebar fold level of the owner strip: >= 1 moves Back/Forward here, 2 also "+". */
  foldLevel: TitlebarChromeFoldLevel
  /** Opens a terminal, like the new-tab shortcut; offered once "+" folds in. */
  onNewTab: () => void
}

function isSlotHidden(slot: HTMLElement | null): boolean {
  return Boolean(slot && slot.childElementCount > 0 && getComputedStyle(slot).display === 'none')
}

export function TabGroupPaneActionsMenu({
  isFocused,
  onCloseGroup,
  worktreeId,
  groupId,
  quickCommandsSlotRef,
  foldLevel,
  onNewTab
}: TabGroupPaneActionsMenuProps): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const canGoBack = useAppStore(canGoBackWorktreeHistory)
  const canGoForward = useAppStore(canGoForwardWorktreeHistory)
  const backShortcut = useShortcutLabel('worktree.history.back')
  const forwardShortcut = useShortcutLabel('worktree.history.forward')
  const newTabShortcut = useShortcutLabel('tab.newTerminal')
  const focusAfterCloseRef = useRef(false)
  const showHistory = foldLevel > 0
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

  // Why: drop ⋯ whole once it can't fit beside the tab floor (and "+", unless that folded in here); the +N chip still outlasts it.
  return (
    <div
      className={
        foldLevel === 2
          ? 'contents @max-[78px]/tab-strip:hidden'
          : 'contents @max-[114px]/tab-strip:hidden'
      }
    >
      <Tooltip>
        <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('auto.components.tab.group.TabGroupPanel.9acaf92093', 'Pane Actions')}
                data-pane-actions-menu-trigger=""
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
              const restoreToStrip = focusAfterCloseRef.current
              focusAfterCloseRef.current = false
              if (!isFocused) {
                event.preventDefault()
                return
              }
              if (restoreToStrip) {
                // History may switch workspaces; only land on this strip's active tab if it is still shown.
                event.preventDefault()
                const focusBefore = captureFocusBeforeRestore()
                requestAnimationFrame(() => {
                  const strip = document.querySelector<HTMLElement>(
                    `[data-tab-group-strip-id="${CSS.escape(groupId)}"]`
                  )
                  const activeSlot = strip?.querySelector<HTMLElement>(
                    '[data-tab-strip-slot]:has([data-active="true"])'
                  )
                  restoreTabStripFocus({
                    strip,
                    slotId: activeSlot?.dataset.tabStripSlot ?? null,
                    stillOwned: () =>
                      useAppStore.getState().activeGroupIdByWorktree[worktreeId] === groupId,
                    focusBefore
                  })
                })
              }
            }}
          >
            {showHistory ? (
              <>
                <DropdownMenuItem
                  disabled={!canGoBack}
                  onSelect={() => {
                    focusAfterCloseRef.current = true
                    runBuiltInOrReplacement('worktree.history.back', () =>
                      useAppStore.getState().goBackWorktree()
                    )
                  }}
                >
                  <ArrowLeft className="size-4" />
                  {t('auto.App.064bd07810', 'Go back')}
                  <DropdownMenuShortcut>{backShortcut}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canGoForward}
                  onSelect={() => {
                    focusAfterCloseRef.current = true
                    runBuiltInOrReplacement('worktree.history.forward', () =>
                      useAppStore.getState().goForwardWorktree()
                    )
                  }}
                >
                  <ArrowRight className="size-4" />
                  {t('auto.App.cf9099fe98', 'Go forward')}
                  <DropdownMenuShortcut>{forwardShortcut}</DropdownMenuShortcut>
                </DropdownMenuItem>
                {foldLevel === 2 ? (
                  <DropdownMenuItem onSelect={() => onNewTab()}>
                    <Plus className="size-4" />
                    {t('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')}
                    <DropdownMenuShortcut>{newTabShortcut}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                ) : null}
                {quickCommands.menu || onCloseGroup ? <DropdownMenuSeparator /> : null}
              </>
            ) : null}
            {quickCommands.menu ? (
              <>
                {quickCommands.menu}
                {onCloseGroup ? <DropdownMenuSeparator /> : null}
              </>
            ) : null}
            {onCloseGroup ? (
              <DropdownMenuItem variant="destructive" onSelect={() => onCloseGroup()}>
                <X className="size-4" />
                {t('auto.components.tab.group.TabGroupPanel.closePaneColumn', 'Close split pane')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <TooltipContent side="bottom" sideOffset={6}>
          {t('auto.components.tab.group.TabGroupPanel.9acaf92093', 'Pane Actions')}
        </TooltipContent>
      </Tooltip>
      {quickCommands.dialog}
    </div>
  )
}
