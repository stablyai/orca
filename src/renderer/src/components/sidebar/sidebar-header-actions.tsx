import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FolderPlus, GitBranchPlus, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { openWorkspaceCreationComposerWithTourHandoff } from '../contextual-tours/workspace-creation-tour-handoff'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'

function SidebarCreateMenu({
  preserveWorkspaceBoardOpen
}: {
  preserveWorkspaceBoardOpen: boolean
}): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const keybindings = useAppStore((s) => s.keybindings)
  const [open, setOpen] = useState(false)
  const menuContentRef = useRef<HTMLDivElement | null>(null)
  // Why primary: workspace.create binds both Mod+N and Mod+Shift+N, and listing
  // every alias in a two-row menu reads as noise rather than help.
  const newWorktreeShortcutLabel = formatOptionalPrimaryShortcutLabel(
    'workspace.create',
    keybindings
  )
  const boardAttr = preserveWorkspaceBoardOpen ? '' : undefined

  // Why query, not a ref on the item: Radix wraps each item in a roving-focus Slot,
  // and a second ref on that child conflicts with the one the Slot already owns.
  // Why at all: Radix highlights the first item only when opened by keyboard, so a
  // mouse click would otherwise leave Enter with nothing to activate.
  useEffect(() => {
    if (!open) {
      return
    }
    const frame = requestAnimationFrame(() =>
      menuContentRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    )
    return () => cancelAnimationFrame(frame)
  }, [open])

  // Why: the tour highlights this trigger, so the handoff has to fire from the
  // menu item rather than the button that now only opens the menu.
  const handleCreateWorkspace = useCallback(() => {
    // Why: opening after Radix tears down the menu prevents its focus restoration
    // from treating the new dialog as an outside interaction.
    window.setTimeout(openWorkspaceCreationComposerWithTourHandoff, 0)
  }, [])

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              className="text-muted-foreground"
              aria-label={translate('auto.components.sidebar.SidebarHeader.createMenu', 'Create')}
              data-workspace-board-preserve-open={boardAttr}
              data-contextual-tour-target="workspace-create-control"
            >
              <Plus className="size-3.5" strokeWidth={2.25} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('auto.components.sidebar.SidebarHeader.createMenu', 'Create')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="bottom"
        // Why start: the menu hangs from the button's left edge and opens rightward.
        align="start"
        // Keep the panel clear of the trigger: Radix opens on pointerdown, and an
        // overlapping first item activates on the same click's pointerup.
        sideOffset={4}
        ref={menuContentRef}
        className="w-52 p-1.5"
        data-workspace-board-preserve-open={boardAttr}
      >
        <DropdownMenuItem
          className="cursor-pointer gap-2.5 py-1.5"
          onSelect={handleCreateWorkspace}
        >
          {/* GitBranchPlus matches the create-workspace button on the landing screen. */}
          <GitBranchPlus className="size-3.5" strokeWidth={2.25} />
          {translate('auto.components.sidebar.SidebarHeader.92154beb7e', 'New workspace')}
          {newWorktreeShortcutLabel ? (
            <DropdownMenuShortcut>{newWorktreeShortcutLabel}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer gap-2.5 py-1.5"
          onSelect={() => openModal('add-repo')}
        >
          <FolderPlus className="size-3.5" strokeWidth={2.25} />
          {translate('auto.components.sidebar.SidebarHeader.addProject', 'Add project')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function SidebarHeaderActions({
  onWorkspaceBoardMenuOpenChange,
  hideWorkspaceOptions = false
}: {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
  hideWorkspaceOptions?: boolean
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {hideWorkspaceOptions ? null : (
        <SidebarWorkspaceOptionsMenu
          preserveWorkspaceBoardOpen
          onMenuOpenChange={onWorkspaceBoardMenuOpenChange}
        />
      )}
      <SidebarCreateMenu preserveWorkspaceBoardOpen />
    </div>
  )
}
