import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  AI_VAULT_SESSION_LIMITS,
  DEFAULT_AI_VAULT_SESSION_LIMIT,
  type AiVaultSessionLimit
} from './ai-vault-session-limit'

export function AiVaultSessionLimitMenu({
  sessionLimit,
  onSessionLimitChange
}: {
  sessionLimit: AiVaultSessionLimit
  onSessionLimitChange: (limit: AiVaultSessionLimit) => void
}): React.JSX.Element {
  const sessionLimitLabel =
    sessionLimit === 'unlimited'
      ? translate('auto.components.right.sidebar.AiVaultSessionLimitMenu.unlimited', 'Unlimited')
      : sessionLimit.toLocaleString()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {translate(
          'auto.components.right.sidebar.AiVaultSessionLimitMenu.historyDepth',
          'History depth: {{value0}}',
          { value0: sessionLimitLabel }
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-60">
        <DropdownMenuLabel className="whitespace-normal font-normal leading-4">
          {translate(
            'auto.components.right.sidebar.AiVaultSessionLimitMenu.performanceWarning',
            'Larger histories can slow the entire app, especially on remote hosts. Unlimited scans all available history.'
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={String(sessionLimit)}
          onValueChange={(value) =>
            onSessionLimitChange(
              value === 'unlimited' ? 'unlimited' : (Number(value) as AiVaultSessionLimit)
            )
          }
        >
          {AI_VAULT_SESSION_LIMITS.map((limit) => (
            <DropdownMenuRadioItem key={limit} value={String(limit)}>
              <span>
                {limit === 'unlimited'
                  ? translate(
                      'auto.components.right.sidebar.AiVaultSessionLimitMenu.unlimited',
                      'Unlimited'
                    )
                  : limit.toLocaleString()}
              </span>
              <span className="ml-auto text-[11px] font-normal text-muted-foreground">
                {limit === DEFAULT_AI_VAULT_SESSION_LIMIT
                  ? translate(
                      'auto.components.right.sidebar.AiVaultSessionLimitMenu.recommended',
                      'Recommended'
                    )
                  : limit === 500
                    ? translate(
                        'auto.components.right.sidebar.AiVaultSessionLimitMenu.mayBeSlower',
                        'May be slower'
                      )
                    : translate(
                        'auto.components.right.sidebar.AiVaultSessionLimitMenu.slowest',
                        'Slowest'
                      )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
