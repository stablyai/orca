import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { GeminiIcon } from '../status-bar/icons'
import type { AntigravityAccountState } from '../../../../preload/api/agent-account-api'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

export function AntigravityAccountsSection({
  quota
}: {
  quota: ProviderRateLimits | null
}): React.JSX.Element {
  const [state, setState] = useState<AntigravityAccountState>({
    accounts: [],
    activeAccountId: null
  })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    void window.api.antigravityAccounts
      .list()
      .then((next) => {
        if (current) {
          setState(next)
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [])

  const run = async (operation: () => Promise<AntigravityAccountState>): Promise<void> => {
    setBusy(true)
    try {
      setState(await operation())
    } catch (error) {
      toast.error(String(error instanceof Error ? error.message : error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section id="accounts-antigravity" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <GeminiIcon size={16} />
          {translate('auto.components.settings.AccountsPane.antigravity', 'Antigravity (agy)')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.antigravityDescription',
            'Native agy accounts and the account currently used by Antigravity.'
          )}
        </p>
      </div>
      <div className="space-y-2">
        {quota && (
          <p className="text-xs text-muted-foreground">
            {translate('auto.components.settings.AccountsPane.antigravityQuota', 'Quota:')}{' '}
            {quota.status === 'ok'
              ? translate(
                  'auto.components.settings.AccountsPane.antigravityQuotaWindows',
                  '{{value0}} model windows available',
                  { value0: quota.buckets?.length ?? 0 }
                )
              : (quota.error ??
                translate(
                  'auto.components.settings.AccountsPane.antigravityUnavailable',
                  'Unavailable'
                ))}
          </p>
        )}
        {state.accounts.map((account) => (
          <div
            key={account.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            data-current={state.activeAccountId === account.id}
          >
            <div className="min-w-0">
              <p className="truncate text-sm">
                {account.email ??
                  account.subject ??
                  translate(
                    'auto.components.settings.AccountsPane.antigravitySignedIn',
                    'Signed-in Antigravity account'
                  )}
              </p>
              <p className="text-xs text-muted-foreground">
                {state.activeAccountId === account.id
                  ? translate('auto.components.settings.AccountsPane.antigravityActive', 'Active')
                  : account.authMethod}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {state.activeAccountId !== account.id && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.api.antigravityAccounts.select({ accountId: account.id }))
                  }
                >
                  {translate('auto.components.settings.AccountsPane.antigravityUse', 'Use')}
                </Button>
              )}
              {state.activeAccountId !== account.id && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.api.antigravityAccounts.remove({ accountId: account.id }))
                  }
                >
                  {translate('auto.components.settings.AccountsPane.antigravityRemove', 'Remove')}
                </Button>
              )}
            </div>
          </div>
        ))}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void run(() => window.api.antigravityAccounts.add())}
        >
          {translate(
            'auto.components.settings.AccountsPane.antigravityAddCurrent',
            'Add current agy account'
          )}
        </Button>
      </div>
    </section>
  )
}
