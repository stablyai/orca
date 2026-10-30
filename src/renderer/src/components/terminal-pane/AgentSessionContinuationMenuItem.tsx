import { MessageSquarePlus } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

type AgentSessionContinuationMenuItemProps = {
  disabled?: boolean
  onSelect: () => void
}

export function AgentSessionContinuationMenuItem({
  onSelect,
  disabled = false
}: AgentSessionContinuationMenuItemProps): React.JSX.Element {
  return (
    <DropdownMenuItem disabled={disabled} onSelect={onSelect}>
      <MessageSquarePlus />
      {translate(
        'components.agentSessionContinuation.handOffToAnotherAgent',
        'Hand Off to Another Agent'
      )}
    </DropdownMenuItem>
  )
}
