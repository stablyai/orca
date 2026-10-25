import { X } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

/** The pane action is also available from any tab's context menu. */
export function CloseSplitPaneMenuItem({
  onCloseSplitPane
}: {
  onCloseSplitPane: (() => void) | undefined
}): React.JSX.Element | null {
  if (!onCloseSplitPane) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={() => onCloseSplitPane()}>
        <X className="size-3.5" />
        {translate('auto.components.tab.group.TabGroupPanel.closePaneColumn', 'Close split pane')}
      </DropdownMenuItem>
    </>
  )
}
