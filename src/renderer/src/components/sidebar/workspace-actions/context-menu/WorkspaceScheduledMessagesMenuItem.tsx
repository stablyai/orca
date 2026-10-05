import type { JSX } from 'react'
import { Clock } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

type WorkspaceScheduledMessagesMenuItemProps = {
  pendingCount: number
  disabled: boolean
  onSelect: () => void
}

export function WorkspaceScheduledMessagesMenuItem({
  pendingCount,
  disabled,
  onSelect
}: WorkspaceScheduledMessagesMenuItemProps): JSX.Element {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      disabled={disabled}
      aria-label={
        pendingCount > 0
          ? translate(
              'auto.components.sidebar.WorktreeContextMenu.scheduledMessagesWithCount',
              'Schedule message… ({{pending}} pending)',
              { pending: String(pendingCount) }
            )
          : undefined
      }
    >
      <Clock className="size-3.5" />
      {translate(
        'auto.components.sidebar.WorktreeContextMenu.scheduledMessages',
        'Schedule message…'
      )}
      {pendingCount > 0 ? <DropdownMenuShortcut>{pendingCount}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  )
}
