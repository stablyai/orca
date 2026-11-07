import type { JSX } from 'react'
import { Bell, BellOff } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export function WorktreeReadStateMenuItem({
  isUnread,
  disabled,
  onSelect
}: {
  isUnread: boolean | undefined
  disabled: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <DropdownMenuItem onSelect={onSelect} disabled={disabled}>
      {isUnread ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
      {isUnread
        ? translate('auto.components.sidebar.WorktreeContextMenu.8dacff1fe0', 'Mark Read')
        : translate('auto.components.sidebar.WorktreeContextMenu.f50603c6b2', 'Mark Unread')}
    </DropdownMenuItem>
  )
}
