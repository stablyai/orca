import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import type { HistoryAccountCatalogs } from './history-account-context'
import { agentLabel } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-filters'
const EMPTY_CATALOGS: HistoryAccountCatalogs = {}

export function HistoryAccountFilter({
  value,
  onChange,
  catalogs = EMPTY_CATALOGS
}: {
  value: string
  onChange: (value: string) => void
  catalogs?: HistoryAccountCatalogs
}) {
  const t = useTranslate()
  return (
    <div className="px-3 pb-2">
      <Select
        value={value}
        onValueChange={(next) => {
          onChange(next)
        }}
      >
        <SelectTrigger
          size="sm"
          className="w-full"
          aria-label={t('historyResume.storageFilter', 'Stored in account')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('aiVault.accounts.all', 'All accounts')}</SelectItem>
          {Object.entries(catalogs).flatMap(([host, catalog]) =>
            (['codex', 'claude'] as const).flatMap((provider) => [
              <SelectItem
                key={`${host}-${provider}-system`}
                value={JSON.stringify([host, provider, null])}
              >
                {agentLabel(provider)} · {t('accounts.claude.systemDefault', 'System default')}
              </SelectItem>,
              ...catalog[provider].accounts.map((account) => (
                <SelectItem
                  key={`${host}-${provider}-${account.id}`}
                  value={JSON.stringify([host, provider, account.id])}
                >
                  {agentLabel(provider)} · {account.displayName ?? account.email}
                </SelectItem>
              ))
            ])
          )}
        </SelectContent>
      </Select>
    </div>
  )
}
