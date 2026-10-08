import type { ExtraUsageBalance, ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { clampUsedPercent } from '../../../../shared/usage-percentage-display'
import { formatCreditCount } from '../../../../shared/credit-count-format'
import { formatCurrencyAmount } from '../../../../shared/currency-format'
import { translate } from '@/i18n/i18n'
import { formatUsagePercentageLabel } from './usage-percentage-label'

export const USAGE_WARNING_PERCENT = 60
export const USAGE_URGENT_PERCENT = 80

export function barColor(usedPct: number): string {
  if (usedPct < USAGE_WARNING_PERCENT) {
    return 'bg-muted-foreground/40'
  }
  if (usedPct < USAGE_URGENT_PERCENT) {
    return 'bg-yellow-500'
  }
  return 'bg-red-500'
}

export function getExtraUsageLabel(provider: ProviderRateLimits['provider']): string {
  if (provider === 'claude') {
    return translate('auto.components.status.bar.tooltip.7404abbece', 'Usage credits')
  }
  if (provider === 'opencode-go') {
    return translate('auto.components.status.bar.tooltip.fbc80d8be2', 'Zen balance')
  }
  if (provider === 'codex') {
    return translate('auto.components.status.bar.tooltip.f21b2ba897', 'Credits')
  }
  return translate('auto.components.status.bar.tooltip.c03c61f53f', 'Balance')
}

function renderUncappedBalanceLine(balance: ExtraUsageBalance): string {
  if (balance.unit === 'credits') {
    if (balance.unlimited) {
      return translate('auto.components.status.bar.tooltip.56c0d70577', 'Unlimited')
    }
    return translate(
      'auto.components.status.bar.tooltip.87b5bda4d3',
      '{{value0}} credits available',
      { value0: formatCreditCount(balance.balance) }
    )
  }
  if (balance.balance === null) {
    return ''
  }
  const currencyText = formatCurrencyAmount(balance.balance, balance.currencyCode)
  return translate('auto.components.status.bar.tooltip.f6a27a3c0a', '{{value0}} available', {
    value0: currencyText
  })
}

export function ProviderExtraUsageSection({
  balance,
  provider,
  textClass,
  mutedClass,
  faintClass,
  emptyBarClass,
  usagePercentageDisplay
}: {
  balance: ExtraUsageBalance
  provider: ProviderRateLimits['provider']
  textClass: string
  mutedClass: string
  faintClass: string
  emptyBarClass: string
  usagePercentageDisplay: UsagePercentageDisplay
}): React.JSX.Element | null {
  const label = getExtraUsageLabel(provider)
  if (balance.unit === 'credits') {
    return (
      <div className="space-y-1">
        <div className={`font-medium ${textClass}`}>{label}</div>
        <div className={mutedClass}>{renderUncappedBalanceLine(balance)}</div>
      </div>
    )
  }

  if (provider === 'opencode-go' && balance.balance === null) {
    const status =
      balance.disabledReason === 'refresh-failed'
        ? translate('auto.components.status.bar.tooltip.e740f92596', 'Refresh failed')
        : translate('auto.components.status.bar.tooltip.1292d4f2ee', 'Unavailable')
    return (
      <div className="space-y-1">
        <div className={`font-medium ${textClass}`}>{label}</div>
        <div className={mutedClass}>{status}</div>
        {balance.disabledReason === 'api-key-source' ? (
          <div className={faintClass}>
            {translate(
              'auto.components.status.bar.provider.extra.usage.section.apiKeyBalanceUnavailable',
              'Balance is not included in this usage response.'
            )}
          </div>
        ) : null}
      </div>
    )
  }

  const capped =
    balance.spendLimit !== null && balance.spentPercent !== null && balance.spent !== null
  const balanceText =
    balance.balance === null ? null : formatCurrencyAmount(balance.balance, balance.currencyCode)
  if (!capped) {
    const limitText =
      balance.spendLimit === null
        ? null
        : formatCurrencyAmount(balance.spendLimit, balance.currencyCode)
    const limitLabel =
      limitText === null
        ? null
        : translate(
            'auto.components.status.bar.provider.extra.usage.section.135d51c19f',
            'Limit {{value0}}',
            { value0: limitText }
          )
    if (balanceText === null && limitLabel === null) {
      return null
    }
    return (
      <div className="space-y-1">
        <div className={`font-medium ${textClass}`}>{label}</div>
        <div className={mutedClass}>
          {balanceText === null ? limitLabel : renderUncappedBalanceLine(balance)}
        </div>
      </div>
    )
  }

  const spentPct = clampUsedPercent(balance.spentPercent ?? 0)
  const spent = formatCurrencyAmount(balance.spent ?? 0, balance.currencyCode)
  const limit = formatCurrencyAmount(balance.spendLimit ?? 0, balance.currencyCode)
  return (
    <div className="space-y-1">
      <div className={`font-medium ${textClass}`}>{label}</div>
      <div className={`h-[6px] w-full overflow-hidden rounded-full ${emptyBarClass}`}>
        <div
          className={`h-full rounded-full ${barColor(spentPct)} transition-all duration-300`}
          style={{ width: `${spentPct}%` }}
        />
      </div>
      <div className={`flex justify-between ${mutedClass}`}>
        <span>{`${spent} / ${limit}`}</span>
        <span>{formatUsagePercentageLabel(spentPct, usagePercentageDisplay)}</span>
      </div>
      {balanceText !== null ? (
        <div className={faintClass}>
          {translate('auto.components.status.bar.tooltip.473d45cd0f', 'Balance {{value0}}', {
            value0: balanceText
          })}
        </div>
      ) : null}
    </div>
  )
}
