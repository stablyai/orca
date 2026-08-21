import { MessageSquarePlus } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export function TerminalSideQuestMenuItem({
  includesSelection,
  onSelect
}: {
  includesSelection: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <MessageSquarePlus />
      {includesSelection
        ? translate(
            'auto.components.terminal.pane.TerminalContextMenu.addSelectionToSideQuest',
            'Add to Side Quest'
          )
        : translate(
            'auto.components.terminal.pane.TerminalContextMenu.newSideQuest',
            'New Side Quest'
          )}
    </DropdownMenuItem>
  )
}
