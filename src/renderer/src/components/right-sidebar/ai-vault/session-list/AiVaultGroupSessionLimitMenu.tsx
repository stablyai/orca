import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import {
  AI_VAULT_GROUP_SESSION_LIMITS,
  normalizeAiVaultGroupSessionLimit,
  type AiVaultGroupSessionLimit
} from './ai-vault-group-session-limit'

function groupSessionLimitLabel(limit: AiVaultGroupSessionLimit, allLabel: string): string {
  return limit === 'all' ? allLabel : String(limit)
}

export function AiVaultGroupSessionLimitMenu({
  groupSessionLimit,
  onGroupSessionLimitChange
}: {
  groupSessionLimit: AiVaultGroupSessionLimit
  onGroupSessionLimitChange: (limit: AiVaultGroupSessionLimit) => void
}): React.JSX.Element {
  const t = useTranslate()
  const allLabel = t('auto.components.right.sidebar.AiVaultGroupSessionLimitMenu.all', 'All')
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {t(
          'auto.components.right.sidebar.AiVaultGroupSessionLimitMenu.sessionsPerGroup',
          'Sessions per group: {{value0}}',
          { value0: groupSessionLimitLabel(groupSessionLimit, allLabel) }
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
              {groupSessionLimitLabel(limit, allLabel)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
