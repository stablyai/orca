import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  AI_VAULT_GROUP_SESSION_LIMITS,
  normalizeAiVaultGroupSessionLimit,
  type AiVaultGroupSessionLimit
} from './ai-vault-group-session-limit'

function groupSessionLimitLabel(limit: AiVaultGroupSessionLimit): string {
  return limit === 'all'
    ? translate('auto.components.right.sidebar.AiVaultGroupSessionLimitMenu.all', 'All')
    : String(limit)
}

export function AiVaultGroupSessionLimitMenu({
  groupSessionLimit,
  onGroupSessionLimitChange
}: {
  groupSessionLimit: AiVaultGroupSessionLimit
  onGroupSessionLimitChange: (limit: AiVaultGroupSessionLimit) => void
}): React.JSX.Element {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {translate(
          'auto.components.right.sidebar.AiVaultGroupSessionLimitMenu.sessionsPerGroup',
          'Sessions per group: {{value0}}',
          { value0: groupSessionLimitLabel(groupSessionLimit) }
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-32">
        <DropdownMenuRadioGroup
          value={String(groupSessionLimit)}
          onValueChange={(value) =>
            onGroupSessionLimitChange(
              normalizeAiVaultGroupSessionLimit(value === 'all' ? value : Number(value))
            )
          }
        >
          {AI_VAULT_GROUP_SESSION_LIMITS.map((limit) => (
            <DropdownMenuRadioItem key={limit} value={String(limit)}>
              {groupSessionLimitLabel(limit)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
