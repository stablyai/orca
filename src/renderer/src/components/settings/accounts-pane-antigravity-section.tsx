import { translate } from '@/i18n/i18n'
import type { AntigravityRateLimitAccountsState } from '../../../../shared/antigravity-managed-account-types'

type AntigravityAccountsSectionProps = {
  accounts: AntigravityRateLimitAccountsState
  onAdd: () => void
  onRemove: (accountId: string) => void
  onSelect: (accountId: string | null) => void
  onReauthenticate: (accountId: string) => void
  busy: boolean
}

export function AntigravityAccountsSection({
  accounts,
  onAdd,
  onRemove,
  onSelect,
  onReauthenticate,
  busy
}: AntigravityAccountsSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          {translate('auto.components.settings.accounts.antigravity.title', 'Antigravity Accounts')}
        </h3>
        <button
          type="button"
          onClick={onAdd}
          disabled={busy}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {translate('auto.components.settings.accounts.antigravity.add', 'Add Account')}
        </button>
      </div>
      {accounts.accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.accounts.antigravity.empty',
            'No Antigravity accounts added yet.'
          )}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between rounded-md border p-3"
            >
              <div className="flex flex-col">
                <span className="text-sm font-medium">{account.label}</span>
                {account.email && (
                  <span className="text-xs text-muted-foreground">{account.email}</span>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onSelect(account.id)}
                  disabled={busy || accounts.activeAccountId === account.id}
                  className="rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                >
                  {accounts.activeAccountId === account.id
                    ? translate('auto.components.settings.accounts.antigravity.active', 'Active')
                    : translate('auto.components.settings.accounts.antigravity.select', 'Select')}
                </button>
                <button
                  type="button"
                  onClick={() => onReauthenticate(account.id)}
                  disabled={busy}
                  className="rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                >
                  {translate('auto.components.settings.accounts.antigravity.reauth', 'Re-auth')}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(account.id)}
                  disabled={busy}
                  className="rounded-md border border-destructive px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  {translate('auto.components.settings.accounts.antigravity.remove', 'Remove')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
