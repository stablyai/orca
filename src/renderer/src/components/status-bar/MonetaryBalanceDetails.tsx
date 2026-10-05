import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'
import { getProviderUsageErrorMessage } from './usage-error-copy'

export function MonetaryBalanceDetails({ p }: { p: ProviderRateLimits }): React.JSX.Element {
  return (
    <div className="space-y-2 text-xs" role="status" aria-live="polite">
      {p.balance?.balance_infos.map((row) => (
        <div key={row.currency} className="space-y-1">
          <div className="flex justify-between gap-4 font-medium">
            <span>{translate('deepseek.balance.total', 'Balance')}</span>
            <span className="tabular-nums">
              {row.currency} {row.total_balance}
            </span>
          </div>
          <div className="flex justify-between gap-4 text-muted-foreground">
            <span>{translate('deepseek.balance.granted', 'Granted')}</span>
            <span className="tabular-nums">
              {row.currency} {row.granted_balance}
            </span>
          </div>
          <div className="flex justify-between gap-4 text-muted-foreground">
            <span>{translate('deepseek.balance.toppedUp', 'Topped up')}</span>
            <span className="tabular-nums">
              {row.currency} {row.topped_up_balance}
            </span>
          </div>
        </div>
      ))}
      {p.balance?.is_available === false ? (
        <p className="text-muted-foreground">
          {translate(
            'deepseek.balance.insufficient',
            'DeepSeek reports insufficient balance for API calls.'
          )}
        </p>
      ) : null}
      {p.status === 'error' ? (
        <p className="text-muted-foreground">
          {p.balance
            ? translate('deepseek.balance.stale', 'Refresh failed — showing the last balance.')
            : getProviderUsageErrorMessage(p)}
        </p>
      ) : !p.balance ? (
        <p className="text-muted-foreground">
          {translate('deepseek.balance.pending', 'Balance unavailable')}
        </p>
      ) : null}
      {p.balance && p.updatedAt ? (
        <p className="text-muted-foreground">
          {translate('deepseek.balance.updated', 'Updated {{when}}', {
            when: new Date(p.updatedAt).toLocaleString()
          })}
        </p>
      ) : null}
    </div>
  )
}
