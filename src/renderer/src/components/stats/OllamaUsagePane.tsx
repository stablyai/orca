import { useState } from 'react'
import { CalendarClock, Coins, Cpu, ExternalLink, RefreshCw, ShoppingBag } from 'lucide-react'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { StatCard } from './StatCard'
import { formatUpdatedAt } from './usage-formatters'

/** Ollama cloud subscription usage: account-wide spend/balance labels; token counts are totals, not per-session analytics. */
export function OllamaUsagePane(): React.JSX.Element {
  const ollama = useAppStore((s) => s.rateLimits.ollama)
  const ollamaApiKeyConfigured = useAppStore((s) => s.rateLimits.ollamaApiKeyConfigured)
  const refreshOllamaRateLimits = useAppStore((s) => s.refreshOllamaRateLimits)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const handleRefresh = (): void => {
    if (isRefreshing) {
      return
    }
    setIsRefreshing(true)
    void refreshOllamaRateLimits().finally(() => setIsRefreshing(false))
  }

  const openOllamaAccounts = (): void => {
    openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'accounts-ollama' })
    openSettingsPage()
  }

  const paneTitle = translate('auto.components.stats.OllamaUsagePane.title', 'Ollama cloud usage')

  if (!ollamaApiKeyConfigured) {
    return (
      <div
        className="rounded-lg border border-border/60 bg-card/40 p-4"
        data-testid="ollama-usage-pane"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{paneTitle}</h3>
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.stats.OllamaUsagePane.notConfiguredDescription',
                'Cloud subscription usage from ollama.com (API key from ollama.com/settings/keys). Same source as the status bar.'
              )}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              recordFeatureInteraction('usage-tracking')
              openOllamaAccounts()
            }}
          >
            {translate('auto.components.stats.OllamaUsagePane.setupButton', 'Set up in Accounts')}
          </Button>
        </div>
      </div>
    )
  }

  const balance = ollama?.extraUsage
  const currency = balance?.unit === 'currency' ? balance : null
  const totals = ollama?.ollamaUsageTotals ?? null
  const includedText =
    currency?.balance !== null && currency?.balance !== undefined
      ? `$${currency.balance.toFixed(2)}`
      : null
  const spendLimitText =
    currency?.spendLimit !== null && currency?.spendLimit !== undefined
      ? `$${currency.spendLimit.toFixed(2)}`
      : null
  const purchasedText =
    totals?.purchasedBalanceUsd !== null && totals?.purchasedBalanceUsd !== undefined
      ? `$${totals.purchasedBalanceUsd.toFixed(2)}`
      : null

  return (
    <div
      className="space-y-4 rounded-lg border border-border/60 bg-card/40 p-4"
      data-testid="ollama-usage-pane"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{paneTitle}</h3>
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.stats.OllamaUsagePane.description',
              'Cloud credits and 30-day usage from ollama.com. Same source as the status bar.'
            )}
          </p>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleRefresh}
                disabled={isRefreshing}
                aria-label={translate(
                  'auto.components.stats.OllamaUsagePane.refreshLabel',
                  'Refresh Ollama usage'
                )}
              >
                <RefreshCw className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.stats.OllamaUsagePane.refresh', 'Refresh')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <StatCard
          label={translate(
            'auto.components.stats.OllamaUsagePane.includedCredits',
            'Included credits left'
          )}
          value={
            includedText
              ? spendLimitText
                ? `${includedText} / ${spendLimitText}`
                : includedText
              : '—'
          }
          icon={<Coins className="size-4" />}
        />
        <StatCard
          label={translate(
            'auto.components.stats.OllamaUsagePane.purchasedCredits',
            'Purchased credits'
          )}
          value={purchasedText ?? '—'}
          icon={<ShoppingBag className="size-4" />}
        />
        <StatCard
          label={translate('auto.components.stats.OllamaUsagePane.monthSpend', '30-day spend')}
          value={totals?.spentUsd != null ? `$${totals.spentUsd.toFixed(2)}` : '—'}
          icon={<Cpu className="size-4" />}
        />
        <StatCard
          label={translate(
            'auto.components.stats.OllamaUsagePane.periodReset',
            'Plan period resets'
          )}
          value={balance?.resetsAt ? formatUpdatedAt(balance.resetsAt) : '—'}
          icon={<CalendarClock className="size-4" />}
        />
      </div>

      {/* Legacy plans answer session/weekly remaining percents; modern plans report
          windowless USD balances, so these rows only appear when the API sent them. */}
      {(ollama?.session || ollama?.weekly) && (
        <div className="grid gap-3 md:grid-cols-2">
          {ollama?.session ? (
            <StatCard
              label={translate(
                'auto.components.stats.OllamaUsagePane.sessionWindow',
                '5 hours used'
              )}
              value={`${Math.round(ollama.session.usedPercent)}%`}
              icon={<CalendarClock className="size-4" />}
            />
          ) : null}
          {ollama?.weekly ? (
            <StatCard
              label={translate('auto.components.stats.OllamaUsagePane.weeklyWindow', 'Weekly used')}
              value={`${Math.round(ollama.weekly.usedPercent)}%`}
              icon={<CalendarClock className="size-4" />}
            />
          ) : null}
        </div>
      )}
      {totals?.inputTokens != null ? (
        <p className="px-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.stats.OllamaUsagePane.tokenTotals',
            '30-day tokens: {{value0}} in · {{value1}} cached · {{value2}} out across {{value3}} requests',
            {
              value0: totals.inputTokens.toLocaleString(getIntlLocale()),
              value1: (totals.cachedInputTokens ?? 0).toLocaleString(getIntlLocale()),
              value2: (totals.outputTokens ?? 0).toLocaleString(getIntlLocale()),
              value3: (totals.requestCount ?? 0).toLocaleString(getIntlLocale())
            }
          )}
        </p>
      ) : null}

      {ollama?.usageMetadata?.lastSuccessfulSource ? (
        <p className="px-1 text-xs text-muted-foreground">
          {ollama.usageMetadata.lastSuccessfulSource}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 px-1">
        <Button variant="ghost" size="sm" onClick={openOllamaAccounts}>
          {translate(
            'auto.components.stats.OllamaUsagePane.accountSettings',
            'Ollama cloud account settings'
          )}
          <ExternalLink className="size-3" />
        </Button>
      </div>
    </div>
  )
}
