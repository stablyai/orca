import { X } from 'lucide-react'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export function CloseSplitPaneMenuItem({
  onCloseSplitPane,
  menuKind = 'dropdown'
}: {
  menuKind?: 'dropdown' | 'context'
  onCloseSplitPane: (() => void) | undefined
}): React.JSX.Element | null {
  const Item = menuKind === 'context' ? ContextMenuItem : DropdownMenuItem
  const Separator = menuKind === 'context' ? ContextMenuSeparator : DropdownMenuSeparator
  if (!onCloseSplitPane) {
    return null
  }
  return (
    <>
      <Separator />
      <Item variant="destructive" onSelect={() => onCloseSplitPane()}>
        <X className="size-3.5" />
        {translate('auto.components.tab.group.TabGroupPanel.closePaneColumn', 'Close split pane')}
      </Item>
    </>
  )
}
