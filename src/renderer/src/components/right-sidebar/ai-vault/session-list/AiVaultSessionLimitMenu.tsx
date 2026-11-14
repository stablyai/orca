import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
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
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const sessionLimitLabel =
    sessionLimit === 'unlimited'
      ? t('auto.components.right.sidebar.AiVaultSessionLimitMenu.unlimited', 'Unlimited')
      : sessionLimit.toLocaleString(intlLocale)
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {t(
          'auto.components.right.sidebar.AiVaultSessionLimitMenu.historyDepth',
          'History depth: {{value0}}',
          { value0: sessionLimitLabel }
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-60">
        <DropdownMenuLabel className="whitespace-normal font-normal leading-4">
          {t(
            'auto.components.right.sidebar.AiVaultSessionLimitMenu.performanceWarning',
            'Larger histories can slow the entire app, especially on remote hosts. Unlimited scans all available history.'
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={String(sessionLimit)}
          onValueChange={(value) =>
            onSessionLimitChange(value === 'unlimited' ? 'unlimited' : Number(value))
          }
        >
          {AI_VAULT_SESSION_LIMITS.map((limit) => (
            <DropdownMenuRadioItem key={limit} value={String(limit)}>
              <span>
                {limit === 'unlimited'
                  ? t(
                      'auto.components.right.sidebar.AiVaultSessionLimitMenu.unlimited',
                      'Unlimited'
                    )
                  : limit.toLocaleString(intlLocale)}
              </span>
              <span className="ml-auto text-[11px] font-normal text-muted-foreground">
                {limit === DEFAULT_AI_VAULT_SESSION_LIMIT
                  ? t(
                      'auto.components.right.sidebar.AiVaultSessionLimitMenu.recommended',
                      'Recommended'
                    )
                  : limit === 500
                    ? t(
                        'auto.components.right.sidebar.AiVaultSessionLimitMenu.mayBeSlower',
                        'May be slower'
                      )
                    : t('auto.components.right.sidebar.AiVaultSessionLimitMenu.slowest', 'Slowest')}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
