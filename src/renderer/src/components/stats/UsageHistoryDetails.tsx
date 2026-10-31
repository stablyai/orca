import { useState } from 'react'
import type { UsageHistoryRow } from '../../../../shared/usage-history-types'
import { Button } from '../ui/button'
import { UsageRecentSessionsTable } from './UsageRecentSessionsTable'
import {
  groupUsageHistory,
  usageHistoryAccountKey,
  type UsageHistoryGroup
} from './usage-history-model'
import { formatUsageCost, formatUsageTokens } from './usage-overview-model'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { usageHistoryAccountLabel } from './usage-history-accounts'
import { USAGE_PROVIDER_COLORS } from './usage-history-chart-model'
import { getAgentLabel } from '@/lib/agent-catalog'

export { UsageHistoryDailyChart } from './UsageHistoryDailyChart'

function HistoryTotalsList({
  title,
  rows,
  onSelect
}: {
  title: string
  rows: UsageHistoryGroup[]
  onSelect: (value: string) => void
}): React.JSX.Element {
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0)
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card p-4">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      <p className="mb-3 mt-1 text-xs text-muted-foreground">
        {translate('stats.usage.breakdown.share', 'Share of selected tokens')}
      </p>
      <div className="max-h-64 space-y-1 overflow-y-auto scrollbar-sleek">
        {rows.map((row) => {
          const share = totalTokens > 0 ? (row.totalTokens / totalTokens) * 100 : 0
          const shareLabel = `${share.toLocaleString(getIntlLocale(), { maximumFractionDigits: 1 })}%`
          const providers = new Map<string, { tokens: number; color: string }>()
          for (const entry of row.rows) {
            const provider = providers.get(entry.provider) ?? {
              tokens: 0,
              color: USAGE_PROVIDER_COLORS[entry.provider].color
            }
            provider.tokens += entry.totalTokens
            providers.set(entry.provider, provider)
          }
          return (
            <Button
              key={row.key}
              variant="ghost"
              size="sm"
              onClick={() => onSelect(row.key)}
              className="h-auto w-full flex-col items-stretch"
            >
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0 flex-1 break-all whitespace-normal text-left text-xs">
                  {row.label}
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums">
                  {formatUsageTokens(row.totalTokens)}
                  <span className="ml-2 text-muted-foreground">{shareLabel}</span>
                  <span className="block text-muted-foreground">
                    {formatUsageCost(row.apiEquivalentCostUsd)}
                    {row.hasPartialCost ? ' *' : ''}
                  </span>
                </span>
              </span>
              <span
                aria-hidden="true"
                className="block h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <span
                  className="flex h-full overflow-hidden rounded-full"
                  style={{ width: `${share}%` }}
                  data-usage-share={share}
                >
                  {[...providers].map(([provider, entry]) => (
                    <span
                      key={provider}
                      className="h-full"
                      style={{
                        width: `${row.totalTokens > 0 ? (entry.tokens / row.totalTokens) * 100 : 0}%`,
                        backgroundColor: entry.color
                      }}
                    />
                  ))}
                </span>
              </span>
            </Button>
          )
        })}
      </div>
    </section>
  )
}

export function UsageHistoryBreakdowns({
  rows,
  onModel,
  onProject,
  onAccount,
  accountLabels
}: {
  rows: readonly UsageHistoryRow[]
  onModel: (model: string) => void
  onProject: (project: string) => void
  onAccount: (account: string) => void
  accountLabels: ReadonlyMap<string, string>
}): React.JSX.Element {
  const unknown = translate('stats.usage.unknown', 'Unknown')
  return (
    <div className="grid gap-3 @xl:grid-cols-3">
      <HistoryTotalsList
        title={translate('stats.usage.accounts.title', 'By account · tokens / API estimate')}
        rows={groupUsageHistory(rows, 'account', unknown).map((group) => ({
          ...group,
          label: group.rows[0] ? usageHistoryAccountLabel(group.rows[0], accountLabels) : unknown
        }))}
        onSelect={onAccount}
      />
      <HistoryTotalsList
        title={translate('stats.usage.models.title', 'By model · tokens / API estimate')}
        rows={groupUsageHistory(rows, 'model', unknown)}
        onSelect={onModel}
      />
      <HistoryTotalsList
        title={translate('stats.usage.projects.title', 'By project · tokens / API estimate')}
        rows={groupUsageHistory(rows, 'project', unknown)}
        onSelect={onProject}
      />
    </div>
  )
}

export function UsageHistorySessions({
  rows,
  accountLabels
}: {
  rows: readonly UsageHistoryRow[]
  accountLabels: ReadonlyMap<string, string>
}): React.JSX.Element {
  const [limit, setLimit] = useState(20)
  const unknown = translate('stats.usage.unknown', 'Unknown')
  const groups = groupUsageHistory(
    rows,
    'session',
    translate('stats.usage.session.unavailable', 'Session attribution unavailable')
  )
  const sessions = groups
    .map((group) => {
      const models = new Set(group.rows.map((row) => row.model))
      const projects = new Set(group.rows.map((row) => row.projectKey))
      const days = group.rows.map((row) => row.day).sort()
      const accounts = new Set(group.rows.map(usageHistoryAccountKey))
      const first = group.rows[0]
      return {
        sessionId: group.key,
        label: group.label,
        provider: group.rows[0]?.provider,
        accountLabel:
          accounts.size === 1 && first
            ? `${first.accountId ? '' : `${getAgentLabel(first.provider)} · `}${usageHistoryAccountLabel(first, accountLabels)}`
            : translate('stats.usage.account.multiple', 'Multiple accounts'),
        lastActiveAt: days.at(-1) ?? '',
        projectLabel:
          projects.size === 1
            ? (group.rows[0]?.projectLabel ?? unknown)
            : translate('stats.usage.session.multipleProjects', 'Multiple projects'),
        model:
          models.size === 1
            ? (group.rows[0]?.model ?? unknown)
            : translate('stats.usage.session.multipleModels', 'Multiple models'),
        inputTokens: group.newInputTokens + group.cacheReadTokens + group.cacheWriteTokens,
        outputTokens: group.outputTokens,
        group
      }
    })
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  return (
    <div className="space-y-2">
      <UsageRecentSessionsTable
        title={translate('stats.usage.session.title', 'Session drilldown')}
        description={translate(
          'stats.usage.session.description',
          'Tokens match the selected period, account, provider, model, project and day. Select the last recorded day to inspect a session.'
        )}
        headings={[
          translate('stats.usage.session.lastDay', 'Last recorded day'),
          translate('stats.usage.filter.project', 'Project'),
          translate('stats.usage.filter.model', 'Model'),
          translate('stats.usage.session.activity', 'Events / turns'),
          translate('stats.usage.session.input', 'All input'),
          translate('stats.usage.session.output', 'Output'),
          translate('stats.usage.tokens', 'Tokens')
        ]}
        unknownModel={unknown}
        rows={sessions.slice(0, limit)}
        getActivity={(row) =>
          row.group.rows.reduce((total, entry) => total + entry.activityCount, 0)
        }
        getTrailingTokens={(row) => row.group.totalTokens}
        getSessionTimeLabel={(row) => row.lastActiveAt}
        getModelSuffix={renderSessionProvider}
        renderDetails={(row) => renderSessionDetails(row, accountLabels)}
      />
      {sessions.length > limit ? (
        <Button variant="outline" size="sm" onClick={() => setLimit((current) => current + 20)}>
          {translate('stats.usage.session.showMore', 'Show more sessions')}
        </Button>
      ) : null}
    </div>
  )
}

function renderSessionProvider(row: { accountLabel: string }): React.JSX.Element {
  return <span className="block text-xs">{row.accountLabel}</span>
}

function renderSessionDetails(
  row: { label: string; group: UsageHistoryGroup },
  accountLabels: ReadonlyMap<string, string>
): React.JSX.Element {
  const unknown = translate('stats.usage.unknown', 'Unknown')
  return (
    <div className="space-y-2 text-xs">
      <p className="break-all font-medium text-foreground">{row.label}</p>
      <p className="text-muted-foreground">
        {translate('stats.usage.session.estimate', 'API-equivalent estimate: {{cost}}', {
          cost: formatUsageCost(row.group.apiEquivalentCostUsd)
        })}
      </p>
      {row.group.rows.map((entry) => (
        <div
          key={`${entry.day}:${entry.model}:${entry.projectKey}:${usageHistoryAccountKey(entry)}`}
          className="flex flex-wrap justify-between gap-2 text-muted-foreground"
        >
          <span>
            {entry.day} · {usageHistoryAccountLabel(entry, accountLabels)} · {entry.projectLabel} ·{' '}
            {entry.model ?? unknown}
          </span>
          <span className="tabular-nums">{formatUsageTokens(entry.totalTokens)}</span>
        </div>
      ))}
    </div>
  )
}
