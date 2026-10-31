import { useMemo, type Dispatch, type SetStateAction } from 'react'
import type {
  UsageHistoryProvider,
  UsageHistoryRange,
  UsageHistoryRow
} from '../../../../shared/usage-history-types'
import { Button } from '../ui/button'
import { SettingsSegmentedControl } from '../settings/SettingsFormControls'
import { UsageHistoryFilter } from './UsageHistoryFilter'
import {
  filterUsageHistory,
  usageHistoryAccountKey,
  type UsageHistorySelection
} from './usage-history-model'
import { usageHistoryAccountLabel } from './usage-history-accounts'
import { translate } from '@/i18n/i18n'

export function UsageHistoryFilters({
  allRows,
  selection,
  setSelection,
  providers,
  accountLabels
}: {
  allRows: UsageHistoryRow[]
  selection: UsageHistorySelection
  setSelection: Dispatch<SetStateAction<UsageHistorySelection>>
  providers: readonly { value: UsageHistoryProvider; label: string }[]
  accountLabels: ReadonlyMap<string, string>
}): React.JSX.Element {
  const optionRows = useMemo(
    () => filterUsageHistory(allRows, { ...selection, model: null, project: null, day: null }),
    [allRows, selection]
  )
  const unknown = translate('stats.usage.unknown', 'Unknown')
  const accountRows = useMemo(
    () =>
      filterUsageHistory(allRows, {
        ...selection,
        account: null,
        model: null,
        project: null,
        day: null
      }),
    [allRows, selection]
  )
  const selectedAccount = allRows.find((row) => usageHistoryAccountKey(row) === selection.account)
  const accountOptions = [
    ...new Map(
      [...accountRows, ...(selectedAccount ? [selectedAccount] : [])].map((row) => [
        usageHistoryAccountKey(row),
        {
          value: usageHistoryAccountKey(row),
          label: usageHistoryAccountLabel(row, accountLabels)
        }
      ])
    ).values()
  ].sort((a, b) => a.label.localeCompare(b.label))
  const models = [
    ...new Map(
      optionRows.map((row) => [
        row.model ?? 'unknown',
        { value: row.model ?? 'unknown', label: row.model ?? unknown }
      ])
    ).values()
  ].sort((a, b) => a.label.localeCompare(b.label))
  const projects = [
    ...new Map(
      optionRows.map((row) => [row.projectKey, { value: row.projectKey, label: row.projectLabel }])
    ).values()
  ].sort((a, b) => a.label.localeCompare(b.label))
  const rangeOptions: readonly { value: UsageHistoryRange; label: string }[] = [
    { value: '7d', label: translate('stats.usage.period.7d', '7 days') },
    { value: '30d', label: translate('stats.usage.period.30d', '30 days') },
    { value: '90d', label: translate('stats.usage.period.90d', '90 days') },
    { value: 'all', label: translate('stats.usage.period.all', 'All time') }
  ]
  return (
    <div className="space-y-3">
      <SettingsSegmentedControl<UsageHistoryRange>
        value={selection.range}
        onChange={(range) => setSelection((current) => ({ ...current, range, day: null }))}
        ariaLabel={translate('stats.usage.filter.period', 'History period')}
        options={rangeOptions}
        size="sm"
      />
      <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2 @3xl:grid-cols-4">
        <UsageHistoryFilter
          label={translate('stats.usage.filter.provider', 'Provider')}
          allLabel={translate('stats.usage.filter.allProviders', 'All providers')}
          value={selection.provider === 'all' ? null : selection.provider}
          options={providers}
          onChange={(provider) => {
            const selected = providers.find((option) => option.value === provider)
            setSelection((current) => ({
              ...current,
              provider: selected?.value ?? 'all',
              account: null,
              model: null,
              project: null,
              day: null
            }))
          }}
        />
        <UsageHistoryFilter
          label={translate('stats.usage.filter.account', 'Account')}
          allLabel={translate('stats.usage.filter.allAccounts', 'All accounts')}
          value={selection.account ?? null}
          options={accountOptions}
          onChange={(account) =>
            setSelection((current) => ({
              ...current,
              account,
              model: null,
              project: null,
              day: null
            }))
          }
        />
        <UsageHistoryFilter
          label={translate('stats.usage.filter.model', 'Model')}
          allLabel={translate('stats.usage.filter.allModels', 'All models')}
          value={selection.model}
          options={models}
          onChange={(model) => setSelection((current) => ({ ...current, model }))}
        />
        <UsageHistoryFilter
          label={translate('stats.usage.filter.project', 'Project')}
          allLabel={translate('stats.usage.filter.allProjects', 'All projects')}
          value={selection.project}
          options={projects}
          onChange={(project) => setSelection((current) => ({ ...current, project }))}
        />
        <UsageHistoryFilter
          label={translate('stats.usage.filter.scope', 'Project scope')}
          allLabel={translate('stats.usage.filter.allLocal', 'All local projects')}
          value={selection.scope === 'all' ? null : 'orca'}
          options={[
            {
              value: 'orca',
              label: translate('stats.usage.filter.orca', 'Orca projects and folders')
            }
          ]}
          onChange={(scope) =>
            setSelection((current) => ({
              ...current,
              scope: scope === 'orca' ? 'orca' : 'all',
              project: null,
              day: null
            }))
          }
        />
      </div>
      {selection.day ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSelection((current) => ({ ...current, day: null }))}
        >
          {translate('stats.usage.filter.clearDay', '{{day}} · Clear day filter', {
            day: selection.day
          })}
        </Button>
      ) : null}
    </div>
  )
}
