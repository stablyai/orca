import { MessageSquarePlus } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

type AgentSessionContinuationMenuItemProps = {
  disabled?: boolean
  onSelect: () => void
}

export function AgentSessionContinuationMenuItem({
  onSelect,
  disabled = false
}: AgentSessionContinuationMenuItemProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuItem disabled={disabled} onSelect={onSelect}>
      <MessageSquarePlus />
      {t('components.agentSessionContinuation.handOffToAnotherAgent', 'Hand Off to Another Agent')}
    </DropdownMenuItem>
  )
}
