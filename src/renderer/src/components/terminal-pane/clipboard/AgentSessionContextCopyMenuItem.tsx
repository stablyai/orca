import { ClipboardCopy } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

export function AgentSessionContextCopyMenuItem({
  onSelect,
  disabled
}: {
  onSelect: () => void
  disabled?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuItem onSelect={onSelect} disabled={disabled}>
      <ClipboardCopy />
      {t('auto.components.terminal.pane.TerminalContextMenu.cff67afad1', 'Copy Context')}
    </DropdownMenuItem>
  )
}
