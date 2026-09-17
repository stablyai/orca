import React from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatResetCountdown } from '../../../../shared/rate-limit-reset-format'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { AntigravityManagedAccount } from '../../../../shared/managed-account-types'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'

export type ManagedUsageEntry = {
  account: AntigravityManagedAccount
  usage: ProviderRateLimits | null
}

export function AntigravityManagedAccountsList({
  accounts,
  usage,
  now,
  adding,
  addError,
  removingAccountId,
  onAdd,
  onRemove
}: {
  accounts: AntigravityManagedAccount[]
  usage: ManagedUsageEntry[]
  now: number
  adding: boolean
  addError: string | null
  removingAccountId: string | null
  onAdd: () => void
  onRemove: (accountId: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted-foreground">
          {translate(
            'auto.components.settings.AntigravityAccountsSection.managedAccounts',
            'Google Accounts'
          )}
        </h4>
        <Button variant="outline" size="xs" disabled={adding} onClick={onAdd} className="gap-1">
          {adding ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
          {translate(
            'auto.components.settings.AntigravityAccountsSection.addAccount',
            'Add Google account'
          )}
        </Button>
      </div>
      {addError ? <p className="text-xs text-destructive">{addError}</p> : null}
      {accounts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AntigravityAccountsSection.managedAccountsEmpty',
            'No Orca-managed accounts. Add one to track quota per Google account (sub2api-style), or keep using the local Antigravity CLI credentials below.'
          )}
        </p>
      ) : (
        <div className="space-y-1.5">
          {accounts.map((account) => {
            const session =
              usage.find((entry) => entry.account.id === account.id)?.usage?.session ?? null
            const accountCountdown = session?.resetsAt
              ? formatResetCountdown(session.resetsAt - now)
              : null
            const usageEntry = usage.find((entry) => entry.account.id === account.id)?.usage ?? null
            return (
              <div
                key={account.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-muted/10 px-3 py-2 text-xs"
              >
                <div className="min-w-0 space-y-0.5">
                  <span className="block truncate font-medium text-foreground">
                    {account.email}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {usageEntry?.status === 'error' && usageEntry.error
                      ? usageEntry.error
                      : (accountCountdown ??
                        translate(
                          'auto.components.settings.AntigravityAccountsSection.managedAccountNoData',
                          'No quota data yet'
                        ))}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {session ? (
                    <Badge variant="secondary" className="tabular-nums">
                      {translate(
                        'auto.components.settings.AntigravityAccountsSection.usedPercent',
                        '{{value0}}% used',
                        { value0: String(Math.round(session.usedPercent)) }
                      )}
                    </Badge>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={removingAccountId === account.id}
                    onClick={() => onRemove(account.id)}
                    aria-label={translate(
                      'auto.components.settings.AntigravityAccountsSection.removeAccount',
                      'Remove account {{email}}',
                      { email: account.email }
                    )}
                  >
                    {removingAccountId === account.id ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Trash2 className="size-3" />
                    )}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
