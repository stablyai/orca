import { X } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export function ClearPaneTitleMenuItem({
  onSelect,
  shortcut
}: {
  onSelect: () => void
  /** Omitted where the pane's own keyboard shortcut does not reach. */
  shortcut?: string
}): React.JSX.Element {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <X />
      {translate(
        'auto.components.terminal.pane.TerminalContextMenu.clearPaneTitle',
        'Clear Pane Title'
      )}
      {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  )
}
