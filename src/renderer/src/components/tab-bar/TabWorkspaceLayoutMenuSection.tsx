import {
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Columns2 } from 'lucide-react'
import type { TabSplitDirection } from '../../store/slices/tabs'
import { translate } from '@/i18n/i18n'
import { canMoveTabToNewPaneColumn, moveTabToNewPaneColumn } from './tab-move-to-pane-column'

const PANE_COLUMN_DIRECTIONS: TabSplitDirection[] = ['right', 'left', 'down', 'up']

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
  trailingSeparator = false
}: {
  unifiedTabId: string
  groupId: string
  trailingSeparator?: boolean
}): React.JSX.Element | null {
  if (!canMoveTabToNewPaneColumn(unifiedTabId, groupId)) {
    return null
  }

  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="[&>svg:last-child]:size-3.5">
          <Columns2 className="size-3.5 shrink-0" />
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
              {paneColumnDirectionIcon(direction)}
              {paneColumnDirectionLabel(direction)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {trailingSeparator ? <DropdownMenuSeparator /> : null}
    </>
  )
}
