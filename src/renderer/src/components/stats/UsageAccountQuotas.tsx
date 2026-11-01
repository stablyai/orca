import { useEffect } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { clampUsedPercent } from '../../../../shared/usage-percentage-display'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { getWindowSections, ProviderIcon } from '../status-bar/tooltip'
import { formatPlanLabel } from '../status-bar/usage-roster-formatting'
import {
  getProviderDisplayName,
  getProviderUsageErrorMessage
} from '../status-bar/usage-error-copy'
import { formatWindowLabel } from '@/lib/window-label-formatter'
import { getIntlLocale, translate } from '@/i18n/i18n'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { buildUsageAccountQuotaRows } from './usage-account-quota-rows'

export function UsageAccountQuotaCard({
  provider,
  identity,
  runtimeLabel,
  active,
  quotaKey
}: {
  provider: ProviderRateLimits
  identity?: string
  runtimeLabel?: string
  active?: boolean
  quotaKey?: string
}): React.JSX.Element {
  const providerSections = getWindowSections(provider)
  const sections = [
    ...providerSections,
    ...getWindowSections({ ...provider, buckets: [] }).filter(
      (section) => !providerSections.some((existing) => existing.window === section.window)
    )
  ].flatMap((section) =>
    section.window && Number.isFinite(section.window.usedPercent)
      ? [{ ...section, window: section.window }]
      : []
  )
  const error = provider.error ? getProviderUsageErrorMessage(provider) : null
  return (
    <article
      className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid={`usage-quota-${provider.provider}`}
      data-account-key={quotaKey}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ProviderIcon provider={provider.provider} />
          {getProviderDisplayName(provider.provider)}
        </h4>
        {provider.planType ? (
          <span className="text-xs text-muted-foreground">
            {formatPlanLabel(provider.planType)}
          </span>
        ) : null}
      </div>
      {identity ? <p className="break-words text-xs text-foreground">{identity}</p> : null}
      {runtimeLabel ? (
        <p className="text-xs text-muted-foreground">
          {runtimeLabel}
          {active
            ? ` · ${translate('auto.components.status.bar.StatusBar.ff0fbe9311', 'Active')}`
            : ''}
        </p>
      ) : null}
      {sections.map(({ label, window }) => (
        <div key={`${label}:${window.windowMinutes}:${window.resetsAt}`} className="space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              {label}
              {window.windowMinutes > 0 ? ` · ${formatWindowLabel(window.windowMinutes)}` : ''}
            </span>
            <span className="tabular-nums text-foreground">
              {translate('stats.usage.quota.used', '{{percent}}% used', {
                percent: clampUsedPercent(window.usedPercent).toLocaleString(getIntlLocale(), {
                  maximumFractionDigits: 1
                })
              })}
            </span>
          </div>
          <Progress value={clampUsedPercent(window.usedPercent)} aria-label={label} />
          <p className="text-xs text-muted-foreground">
            {window.resetsAt != null
              ? translate('stats.usage.quota.resetsAt', 'Resets {{time}}', {
                  time: new Date(window.resetsAt).toLocaleString(getIntlLocale())
                })
              : (window.resetDescription ??
                translate('stats.usage.quota.resetUnavailable', 'Reset time unavailable'))}
          </p>
        </div>
      ))}
      {sections.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('stats.usage.quota.unavailable', 'Quota data unavailable')}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {provider.status === 'fetching'
          ? translate('stats.usage.quota.refreshing', 'Refreshing quota…')
          : provider.updatedAt > 0
            ? translate('stats.usage.quota.updatedAt', 'Quota checked {{time}}', {
                time: new Date(provider.updatedAt).toLocaleString(getIntlLocale())
              })
            : translate('stats.usage.quota.neverUpdated', 'Quota has not been checked')}
      </p>
      {error ? (
        <p role="status" className="break-words text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {sections.length > 0 &&
      (provider.status === 'error' || provider.usageMetadata?.unverifiableOwner) ? (
        <p className="text-xs text-muted-foreground">
          {translate('stats.usage.quota.lastKnown', 'Last known quota; the latest check failed.')}
        </p>
      ) : null}
    </article>
  )
}

export function UsageAccountQuotas({
  rateLimits,
  accounts = null,
  accountsUnverifiable = false,
  localOwner = false,
  ownerLabel,
  onRefresh,
  onManage
}: {
  rateLimits: RateLimitState
  accounts?: ProviderAccountsSnapshot | null
  accountsUnverifiable?: boolean
  localOwner?: boolean
  ownerLabel: string
  onRefresh: () => void | Promise<void>
  onManage: () => void
}): React.JSX.Element {
  const settings = useAppStore((state) => (localOwner ? state.settings : null))
  const fetchRateLimits = useAppStore((state) => state.fetchRateLimits)
  const fetchInactiveClaude = useAppStore((state) => state.fetchInactiveClaudeAccountUsage)
  const fetchInactiveCodex = useAppStore((state) => state.fetchInactiveCodexAccountUsage)
  useEffect(() => {
    if (localOwner) {
      void fetchRateLimits()
      void fetchInactiveClaude?.()
      void fetchInactiveCodex?.()
    }
  }, [localOwner, fetchRateLimits, fetchInactiveClaude, fetchInactiveCodex])
  const rows = buildUsageAccountQuotaRows(
    rateLimits,
    accounts,
    accountsUnverifiable,
    settings,
    ownerLabel
  )
  return (
    <section className="space-y-3" data-testid="usage-account-quotas">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            {translate('stats.usage.quota.title', 'Current account quotas')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'stats.usage.quota.scope',
              '{{host}} · Account-wide subscription windows. History filters do not change these limits.',
              { host: ownerLabel }
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={rows.some((row) => row.provider.status === 'fetching')}
          onClick={() => void onRefresh()}
          aria-label={translate('stats.usage.quota.refresh', 'Refresh account quotas')}
        >
          <RefreshCw className="size-3.5" />
          {translate('stats.usage.refresh', 'Refresh')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="usage-quota-coverage">
        {accounts && !accountsUnverifiable && !accounts.failedProviders?.length
          ? translate(
              'stats.usage.quota.accountCoverage',
              'Claude and Codex show connected accounts reported by this host. Other providers show the current account only; unavailable windows do not mean zero usage.'
            )
          : translate(
              'stats.usage.quota.partialAccounts',
              'The account list is unavailable or incomplete. Only reported accounts and current provider quota snapshots are shown.'
            )}
      </p>
      {rows.length > 0 ? (
        <div className="grid gap-3 @xl:grid-cols-2">
          {rows.map((row) => (
            <UsageAccountQuotaCard
              key={row.key}
              provider={row.provider}
              identity={row.identity}
              runtimeLabel={row.runtimeLabel}
              active={row.active}
              quotaKey={row.key}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          {translate(
            'stats.usage.quota.noSources',
            'No account quota source is available. Manage provider accounts to check your subscription.'
          )}
        </p>
      )}
      <Button variant="link" size="sm" onClick={onManage} className="h-auto">
        {translate('stats.usage.quota.manage', 'Manage accounts')}
      </Button>
    </section>
  )
}
