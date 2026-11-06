import { ClipboardCopy } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export function AgentSessionContextCopyMenuItem({
  onSelect,
  disabled
}: {
  onSelect: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <DropdownMenuItem onSelect={onSelect} disabled={disabled}>
      <ClipboardCopy />
      {translate('auto.components.terminal.pane.TerminalContextMenu.cff67afad1', 'Copy Context')}
    </DropdownMenuItem>
  )
}
