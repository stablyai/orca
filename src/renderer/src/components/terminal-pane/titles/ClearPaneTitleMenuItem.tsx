import { X } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

export function ClearPaneTitleMenuItem({
  onSelect,
  shortcut
}: {
  onSelect: () => void
  /** Omitted where the pane's own keyboard shortcut does not reach. */
  shortcut?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <X />
      {t('auto.components.terminal.pane.TerminalContextMenu.clearPaneTitle', 'Clear Pane Title')}
      {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  )
}
