import { MessageSquarePlus } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

type AgentSessionContinuationMenuItemProps = {
  onSelect: () => void
}

export function AgentSessionContinuationMenuItem({
  onSelect
}: AgentSessionContinuationMenuItemProps): React.JSX.Element {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <MessageSquarePlus />
      {translate(
        'components.agentSessionContinuation.continueInNewSession',
        'Continue in New Session…'
      )}
    </DropdownMenuItem>
  )
}
