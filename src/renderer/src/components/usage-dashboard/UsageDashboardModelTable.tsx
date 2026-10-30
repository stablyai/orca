import { formatCost, formatTokens } from '../stats/usage-formatters'
import { translate } from '@/i18n/i18n'
import type { UsageDashboardModelRow } from './usage-dashboard-series'

type UsageDashboardModelTableProps = {
  rows: UsageDashboardModelRow[]
  /** Days the fetched breakdown actually covers (7 or 30), which can exceed the chart window. */
  rangeDays: number
}

function getProviderLabel(provider: string): string {
  switch (provider) {
    case 'claude':
      return translate('auto.components.stats.usage.overview.model.544d6d4c16', 'Claude')
    case 'codex':
      return translate('auto.components.stats.usage.overview.model.eb220d193b', 'Codex')
    case 'opencode':
      return translate('auto.components.stats.usage.overview.model.bc474051e5', 'OpenCode')
    case 'muse':
      return translate('auto.lib.agent.catalog.muse_label', 'Muse')
    case 'omp':
      return translate('auto.components.usageDashboard.UsageDashboardModelTable.providerOmp', 'omp')
    default:
      return provider
  }
}

/** Per-model token and cost table for the fetched range, already sorted by total tokens desc. */
export default function UsageDashboardModelTable({
  rows,
  rangeDays
}: UsageDashboardModelTableProps): React.JSX.Element {
  // omp is the only provider reporting reasoning, so the column disappears when it has no data.
  const showReasoning = rows.some((row) => row.reasoningTokens > 0)

  return (
    <section
      className="rounded-lg border border-border/60 bg-card/40"
      data-testid="usage-dashboard-model-table"
    >
      <div className="px-4 pt-4">
        <h4 className="text-sm font-semibold text-foreground">
          {translate('auto.components.usageDashboard.UsageDashboardModelTable.title', 'Models')}
        </h4>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.usageDashboard.UsageDashboardModelTable.description',
            'Tokens and estimated cost by model in the last {{days}} days.',
            { days: rangeDays }
          )}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="mx-4 mb-4 mt-3 rounded-md border border-dashed border-border/60 px-3 py-4 text-xs text-muted-foreground">
          {translate(
            'auto.components.usageDashboard.UsageDashboardModelTable.empty',
            'No model usage in this period yet.'
          )}
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-y border-border/60 text-left text-xs text-muted-foreground">
                {[
                  translate(
                    'auto.components.usageDashboard.UsageDashboardModelTable.provider',
                    'Provider'
                  ),
                  translate('auto.components.stats.OpenCodeUsagePane.08c78441b7', 'Model'),
                  translate('auto.components.stats.OpenCodeUsagePane.0f2f266c9d', 'Input'),
                  translate('auto.components.stats.OpenCodeUsagePane.dfc4513657', 'Output'),
                  translate(
                    'auto.components.usageDashboard.UsageDashboardModelTable.cache',
                    'Cache'
                  ),
                  ...(showReasoning
                    ? [
                        translate(
                          'auto.components.usageDashboard.UsageDashboardModelTable.reasoning',
                          'Reasoning'
                        )
                      ]
                    : []),
                  translate('auto.components.stats.OmpUsagePane.cost', 'Cost')
                ].map((heading) => (
                  <th
                    key={heading}
                    className="sticky top-0 z-10 bg-card px-3 py-2 font-medium last:text-right"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.provider}:${row.model}`}
                  data-model-row={row.model}
                  className="border-b border-border/40 last:border-0"
                >
                  <td className="px-3 py-2 text-muted-foreground">
                    {getProviderLabel(row.provider)}
                  </td>
                  <td className="max-w-48 truncate px-3 py-2 text-foreground">{row.model}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatTokens(row.inputTokens)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatTokens(row.outputTokens)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatTokens(row.cacheReadTokens + row.cacheWriteTokens)}
                  </td>
                  {showReasoning ? (
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatTokens(row.reasoningTokens)}
                    </td>
                  ) : null}
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {row.costUsd === null ? '—' : formatCost(row.costUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
