import {
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Columns2 } from 'lucide-react'
import type { TabSplitDirection } from '../../store/slices/tabs'
import { useAppStore } from '../../store'
import { moveTabToNewPaneColumn, resolveTabPaneColumnMoveTarget } from './tab-move-to-pane-column'
import { TAB_CONTEXT_SUBMENU_CONTENT_CLASS } from './tab-context-menu-sizing'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { TAB_MOVE_TO_SPLIT_COMMANDS, type KeybindingActionId } from '../../../../shared/keybindings'
import {
  translateTabMoveToSplitDirection,
  translateTabMoveToSplitLabel
} from '@/lib/tab-move-to-split-copy'

/** Keeps user-assigned chords visible where each move direction is chosen. */
function PaneColumnDirectionItem({
  actionId,
  direction,
  onSelect
}: {
  actionId: KeybindingActionId
  direction: TabSplitDirection
  onSelect: () => void
}): React.JSX.Element {
  const shortcut = useOptionalShortcutLabel(actionId)
  return (
    <DropdownMenuItem onSelect={onSelect}>
      {paneColumnDirectionIcon(direction)}
      {translateTabMoveToSplitDirection(direction)}
      {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  )
}

/** Keeps icon metadata out of the shared command catalog. */
function paneColumnDirectionIcon(direction: TabSplitDirection): React.JSX.Element {
  switch (direction) {
    case 'right':
      return <ArrowRight className="size-3.5 shrink-0" />
    case 'left':
      return <ArrowLeft className="size-3.5 shrink-0" />
    case 'down':
      return <ArrowDown className="size-3.5 shrink-0" />
    case 'up':
      return <ArrowUp className="size-3.5 shrink-0" />
  }
}

/** Hides the submenu when moving the tab would collapse back to the same layout. */
export function TabWorkspaceLayoutMenuSection({
  unifiedTabId,
  groupId,
  trailingSeparator = false
}: {
  unifiedTabId: string
  groupId: string
  trailingSeparator?: boolean
}): React.JSX.Element | null {
  const target = resolveTabPaneColumnMoveTarget(useAppStore.getState(), unifiedTabId, groupId)
  if (!target) {
    return null
  }

  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="[&>svg:last-child]:size-3.5">
          <Columns2 className="size-3.5 shrink-0" />
          {translateTabMoveToSplitLabel()}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className={TAB_CONTEXT_SUBMENU_CONTENT_CLASS}>
          {TAB_MOVE_TO_SPLIT_COMMANDS.map(({ id, direction }) => (
            <PaneColumnDirectionItem
              key={id}
              actionId={id}
              direction={direction}
              onSelect={() => {
                moveTabToNewPaneColumn({ target, direction })
              }}
            />
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {trailingSeparator ? <DropdownMenuSeparator /> : null}
    </>
  )
}
