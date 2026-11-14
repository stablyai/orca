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
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { usageHistoryAccountLabel } from './usage-history-accounts'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'

export { UsageHistoryDailyChart } from './UsageHistoryDailyChart'

const BREAKDOWN_COLORS = [
  'var(--chart-2)',
  'var(--chart-provider-opencode)',
  'var(--chart-provider-muse)',
  'var(--chart-provider-claude)',
  'var(--chart-1)',
  'var(--chart-5)'
]

function HistoryTotalsList({
  title,
  rows,
  onSelect
}: {
  title: string
  rows: UsageHistoryGroup[]
  onSelect: (value: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0)
  const entries = rows.map((row, index) => ({
    row,
    share: totalTokens > 0 ? (row.totalTokens / totalTokens) * 100 : 0,
    color: BREAKDOWN_COLORS[index % BREAKDOWN_COLORS.length]
  }))
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card p-4">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      <p className="mb-3 mt-1 text-xs text-muted-foreground">
        {t('stats.usage.breakdown.total', 'Share of {{total}} selected tokens', {
          total: formatUsageTokens(totalTokens, intlLocale)
        })}
      </p>
      <div aria-hidden="true" className="mb-3 flex h-2 overflow-hidden rounded-full bg-muted">
        {entries.map(({ row, share, color }) => (
          <span
            key={row.key}
            className="h-full"
            style={{ width: `${share}%`, backgroundColor: color }}
            data-usage-share={share}
            data-usage-group={row.key}
          />
        ))}
      </div>
      <div className="max-h-80 space-y-1 overflow-y-auto scrollbar-sleek">
        {entries.map(({ row, share, color }) => (
          <Button
            key={row.key}
            variant="ghost"
            size="sm"
            onClick={() => onSelect(row.key)}
            className="h-auto w-full items-start whitespace-normal text-left"
          >
            <span
              aria-hidden="true"
              className="mt-1 size-2 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="min-w-0 flex-1 space-y-1">
              <span className="flex items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0 break-words">{row.label}</span>
                <span className="shrink-0 tabular-nums">
                  {share.toLocaleString(intlLocale, { maximumFractionDigits: 1 })}%
                </span>
              </span>
              <span className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                <span>{formatUsageTokens(row.totalTokens, intlLocale)}</span>
                <span>
                  {formatUsageCost(row.apiEquivalentCostUsd, t, intlLocale)}
                  {row.hasPartialCost ? ' *' : ''}
                </span>
              </span>
            </span>
          </Button>
        ))}
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
  const t = useTranslate()
  const unknown = t('stats.usage.unknown', 'Unknown')
  return (
    <div className="grid gap-3 @4xl:grid-cols-3">
      <HistoryTotalsList
        title={t('stats.usage.accounts.title', 'By account · tokens / API estimate')}
        rows={groupUsageHistory(rows, 'account', unknown).map((group) => ({
          ...group,
          label: group.rows[0] ? usageHistoryAccountLabel(group.rows[0], accountLabels, t) : unknown
        }))}
        onSelect={onAccount}
      />
      <HistoryTotalsList
        title={t('stats.usage.models.title', 'By model · tokens / API estimate')}
        rows={groupUsageHistory(rows, 'model', unknown)}
        onSelect={onModel}
      />
      <HistoryTotalsList
        title={t('stats.usage.projects.title', 'By project · tokens / API estimate')}
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
  const t = useTranslate()
  const [limit, setLimit] = useState(20)
  const unknown = t('stats.usage.unknown', 'Unknown')
  const groups = groupUsageHistory(
    rows,
    'session',
    t('stats.usage.session.unavailable', 'Session attribution unavailable')
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
            ? `${first.accountId ? '' : `${getAgentLabel(first.provider)} · `}${usageHistoryAccountLabel(first, accountLabels, t)}`
            : t('stats.usage.account.multiple', 'Multiple accounts'),
        lastActiveAt: days.at(-1) ?? '',
        projectLabel:
          projects.size === 1
            ? (group.rows[0]?.projectLabel ?? unknown)
            : t('stats.usage.session.multipleProjects', 'Multiple projects'),
        model:
          models.size === 1
            ? (group.rows[0]?.model ?? unknown)
            : t('stats.usage.session.multipleModels', 'Multiple models'),
        inputTokens: group.newInputTokens + group.cacheReadTokens + group.cacheWriteTokens,
        outputTokens: group.outputTokens,
        group
      }
    })
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  return (
    <div className="space-y-2">
      <UsageRecentSessionsTable
        title={t('stats.usage.session.title', 'Session drilldown')}
        description={t(
          'stats.usage.session.description',
          'Tokens match the selected period, account, provider, model, project and day. Select the last recorded day to inspect a session.'
        )}
        headings={[
          t('stats.usage.session.lastDay', 'Last recorded day'),
          t('stats.usage.filter.project', 'Project'),
          t('stats.usage.filter.model', 'Model'),
          t('stats.usage.session.activity', 'Events / turns'),
          t('stats.usage.session.input', 'All input'),
          t('stats.usage.session.output', 'Output'),
          t('stats.usage.tokens', 'Tokens')
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
          {t('stats.usage.session.showMore', 'Show more sessions')}
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
