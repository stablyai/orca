import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  claudeAccountName,
  hostClaudeAccounts
} from '@/components/settings/repository/claude-account/claude-account-binding-options'
import {
  setAiVaultClaudeAccountFilter,
  useAiVaultClaudeAccountFilter
} from '../scope/ai-vault-claude-account-filter'

// Why sentinels: Radix forbids empty values, and the filter's own values are undefined and null.
const ALL = '__all__'
const SYSTEM_DEFAULT = '__system_default__'

/** Lists one Claude account's conversations; only shown once this computer has saved accounts. */
export function AiVaultClaudeAccountFilterMenu(): React.JSX.Element | null {
  const t = useTranslate()
  const settings = useAppStore((state) => state.settings)
  const filter = useAiVaultClaudeAccountFilter()
  const accounts = hostClaudeAccounts(settings)
  if (accounts.length === 0) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>
        {t('auto.components.right.sidebar.AiVaultClaudeAccountFilter.label', 'Claude account')}
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={filter === undefined ? ALL : filter === null ? SYSTEM_DEFAULT : filter}
        onValueChange={(value) =>
          setAiVaultClaudeAccountFilter(
            value === ALL ? undefined : value === SYSTEM_DEFAULT ? null : value
          )
        }
      >
        <DropdownMenuRadioItem value={ALL} onSelect={(event) => event.preventDefault()}>
          {t('auto.components.right.sidebar.AiVaultClaudeAccountFilter.all', 'All accounts')}
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value={SYSTEM_DEFAULT} onSelect={(event) => event.preventDefault()}>
          {t('auto.components.status.bar.StatusBar.c676918adc', 'System default')}
        </DropdownMenuRadioItem>
        {accounts.map((account) => (
          <DropdownMenuRadioItem
            key={account.id}
            value={account.id}
            onSelect={(event) => event.preventDefault()}
          >
            <span className="min-w-0 truncate">
              {claudeAccountName(account, settings?.managedAccountDisplayNames)}
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  )
}
