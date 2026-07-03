import {
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import type { TabSplitDirection } from '../../store/slices/tabs'
import { translate } from '@/i18n/i18n'
import { canMoveTabToNewPaneColumn, moveTabToNewPaneColumn } from './tab-move-to-pane-column'

const PANE_COLUMN_DIRECTIONS: TabSplitDirection[] = ['right', 'left', 'down', 'up']

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
  groupId
}: {
  unifiedTabId: string
  groupId: string
}): React.JSX.Element | null {
  if (!canMoveTabToNewPaneColumn(unifiedTabId, groupId)) {
    return null
  }

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          {translate(
            'auto.components.tab.bar.TabWorkspaceLayoutMenuSection.moveToPaneColumn',
            'Move Tab to Split'
          )}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {PANE_COLUMN_DIRECTIONS.map((direction) => (
            <DropdownMenuItem
              key={direction}
              onSelect={() => {
                moveTabToNewPaneColumn({ unifiedTabId, groupId, direction })
              }}
            >
              {paneColumnDirectionLabel(direction)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  )
}
