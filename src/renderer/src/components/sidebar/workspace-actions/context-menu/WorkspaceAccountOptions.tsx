import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

export function WorkspaceAccountOptions({
  accounts,
  provider,
  selectedId,
  loading,
  saving,
  error,
  onSelect
}: {
  provider: string
  accounts: { id: string; label: string }[]
  selectedId?: string
  loading: boolean
  saving: boolean
  error: string | null
  onSelect: (value: string) => void
}) {
  const t = useTranslate()
  if (error || loading) {
    return (
      <DropdownMenuItem disabled>
        {error || t('workspace.codexAccount.loading', 'Loading accounts…')}
      </DropdownMenuItem>
    )
  }
  const missing = selectedId && !accounts.some((account) => account.id === selectedId)
  return (
    <DropdownMenuRadioGroup value={selectedId ?? 'inherit'} onValueChange={onSelect}>
      <DropdownMenuRadioItem value="inherit" disabled={saving}>
        {t('workspace.codexAccount.inherit', 'Use host default')}
      </DropdownMenuRadioItem>
      {missing && (
        <DropdownMenuRadioItem value={selectedId} disabled>
          {t('workspace.codexAccount.missing', 'Assigned account unavailable')}
        </DropdownMenuRadioItem>
      )}
      {accounts.map((account) => (
        <DropdownMenuRadioItem key={account.id} value={account.id} disabled={saving}>
          {account.label}
        </DropdownMenuRadioItem>
      ))}
      {accounts.length === 0 && (
        <DropdownMenuItem disabled>
          {t(
            'workspace.account.empty',
            'Add {{provider}} accounts in Settings > AI Provider Accounts.',
            { provider }
          )}
        </DropdownMenuItem>
      )}
    </DropdownMenuRadioGroup>
  )
}
