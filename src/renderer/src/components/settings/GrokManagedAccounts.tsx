import { translate } from '@/i18n/i18n'
import { useGrokManagedAccounts } from '@/hooks/useGrokManagedAccounts'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { Progress } from '../ui/progress'

export function GrokManagedAccounts({ updatedAt }: { updatedAt?: number }): React.JSX.Element {
  const { state, busy, signingIn, error, run } = useGrokManagedAccounts({ updatedAt })

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {translate(
          'grokAccounts.launchHint',
          'Choose the account for new Grok sessions on this computer. Existing sessions keep their own account.'
        )}
      </p>
      {state?.accounts.map((account) => {
        const usage = state.usage[account.id]
        const usageWindow = usage?.weekly ?? usage?.monthly
        const active = state.activeAccountId === account.id
        return (
          <div
            key={account.id}
            className="flex items-center justify-between gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="truncate text-xs font-medium">{account.email}</p>
              {usageWindow ? (
                <p className="text-xs text-muted-foreground">
                  {usage?.weekly
                    ? translate('grokAccounts.weekly', 'Weekly')
                    : translate('grokAccounts.monthly', 'Monthly')}
                  {' · '}
                  {translate('grokAccounts.used', '{{percent}}% used', {
                    percent: String(Math.round(usageWindow.usedPercent))
                  })}
                  {usageWindow.resetDescription
                    ? ` · ${translate('grokAccounts.reset', 'Resets {{when}}', { when: usageWindow.resetDescription })}`
                    : ''}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {usage?.error ?? translate('grokAccounts.loading', 'Loading usage…')}
                </p>
              )}
              {usageWindow && (
                <Progress
                  value={usageWindow.usedPercent}
                  aria-label={translate('grokAccounts.usageLabel', 'Grok usage for {{email}}', {
                    email: account.email
                  })}
                />
              )}
              {usage?.status === 'error' && (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.api.grokAccounts.reauthenticate(account.id), true)
                  }
                >
                  {translate('grokAccounts.reconnect', 'Reconnect account')}
                </Button>
              )}
            </div>
            {active ? (
              <Badge variant="secondary">{translate('grokAccounts.selected', 'Selected')}</Badge>
            ) : (
              <Button
                variant="outline"
                size="xs"
                disabled={busy}
                onClick={() => void run(() => window.api.grokAccounts.select(account.id))}
              >
                {translate('grokAccounts.select', 'Use account')}
              </Button>
            )}
          </div>
        )
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() => void run(() => window.api.grokAccounts.add(), true)}
        >
          {translate('grokAccounts.add', 'Add Grok account')}
        </Button>
        {state?.activeAccountId && (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => void run(() => window.api.grokAccounts.select(null))}
          >
            {translate('grokAccounts.system', 'Use system login')}
          </Button>
        )}
        {signingIn && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void window.api.grokAccounts.cancelLogin()}
          >
            {translate('grokAccounts.cancel', 'Cancel sign-in')}
          </Button>
        )}
      </div>
      {signingIn && (
        <p className="text-xs text-muted-foreground" role="status">
          {translate('grokAccounts.signingIn', 'Complete Grok sign-in in your browser.')}
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
