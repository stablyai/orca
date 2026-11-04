import {
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuItem,
  ContextMenuShortcut
} from '@/components/ui/context-menu'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Columns2 } from 'lucide-react'
import type { TabSplitDirection } from '../../store/slices/tabs'
import { translate } from '@/i18n/i18n'
import { canMoveTabToNewPaneColumn, moveTabToNewPaneColumn } from './tab-move-to-pane-column'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { TAB_MOVE_TO_SPLIT_COMMANDS, type KeybindingActionId } from '../../../../shared/keybindings'

/** Keeps user-assigned chords visible where each move direction is chosen. */
function PaneColumnDirectionItem({
  actionId,
  direction,
  shortcutLabel,
  onSelect
}: {
  actionId: KeybindingActionId
  direction: TabSplitDirection
  shortcutLabel?: string
  onSelect: () => void
}): React.JSX.Element {
  const assignedShortcut = useOptionalShortcutLabel(actionId)
  const shortcut = shortcutLabel ?? assignedShortcut
  return (
    <ContextMenuItem onSelect={onSelect}>
      {paneColumnDirectionIcon(direction)}
      {paneColumnDirectionLabel(direction)}
      {shortcut ? <ContextMenuShortcut>{shortcut}</ContextMenuShortcut> : null}
    </ContextMenuItem>
  )
}

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

function paneColumnDirectionLabel(direction: TabSplitDirection): string {
  switch (direction) {
    case 'right':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.right', 'Right')
    case 'left':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.left', 'Left')
    case 'down':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.down', 'Down')
    case 'up':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.up', 'Up')
  }
}

export function TabWorkspaceLayoutMenuSection({
  unifiedTabId,
  groupId,
  leadingSeparator = false,
  trailingSeparator = false,
  shortcutLabels
}: {
  unifiedTabId: string
  groupId: string
  leadingSeparator?: boolean
  trailingSeparator?: boolean
  shortcutLabels?: Partial<Record<TabSplitDirection, string>>
}): React.JSX.Element | null {
  if (!canMoveTabToNewPaneColumn(unifiedTabId, groupId)) {
    return null
  }

  return (
    <>
      {leadingSeparator ? <ContextMenuSeparator /> : null}
      <ContextMenuSub>
        <ContextMenuSubTrigger className="[&>svg:last-child]:size-3.5">
          <Columns2 className="size-3.5 shrink-0" />
          {translate(
            'auto.components.tab.bar.TabWorkspaceLayoutMenuSection.moveToPaneColumn',
            'Move Tab to Split'
          )}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent
          animation="none"
          className="max-w-[calc(100vw-1rem)] whitespace-nowrap"
        >
          {TAB_MOVE_TO_SPLIT_COMMANDS.map(({ id, direction }) => (
            <PaneColumnDirectionItem
              key={id}
              actionId={id}
              direction={direction}
              shortcutLabel={shortcutLabels?.[direction]}
              onSelect={() => {
                moveTabToNewPaneColumn({ unifiedTabId, groupId, direction })
              }}
            />
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {trailingSeparator ? <ContextMenuSeparator /> : null}
    </>
  )
}
