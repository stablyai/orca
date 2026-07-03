import type { KimiUsageSessionRow } from '../../../../shared/kimi-usage-types'
import { translate } from '@/i18n/i18n'
import { formatSessionTime, formatTokens } from './usage-formatters'

export function KimiUsageRecentSessionsTable({
  recentSessions
}: {
  recentSessions: KimiUsageSessionRow[]
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">
          {translate('auto.components.stats.KimiUsagePane.4799177b1c', 'Recent sessions')}
        </h4>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.stats.KimiUsagePane.81817a641a',
            'Most recent local Kimi sessions in this scope.'
          )}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.KimiUsagePane.d97bdf6e27', 'Last active')}
              </th>
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.KimiUsagePane.a4738de041', 'Project')}
              </th>
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.KimiUsagePane.08c78441b7', 'Model')}
              </th>
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.KimiUsagePane.d416f5cf92', 'Events')}
              </th>
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.KimiUsagePane.0f2f266c9d', 'Input')}
              </th>
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.KimiUsagePane.dfc4513657', 'Output')}
              </th>
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.KimiUsagePane.349f7c3f5c', 'Total')}
              </th>
            </tr>
          </thead>
          <tbody>
            {recentSessions.map((row) => (
              <tr key={row.sessionId} className="border-b border-border/40 last:border-b-0">
                <td className="px-2 py-2 text-muted-foreground">
                  {formatSessionTime(row.lastActiveAt)}
                </td>
                <td className="px-2 py-2 text-foreground">{row.projectLabel}</td>
                <td className="px-2 py-2 text-muted-foreground">
                  {row.model ??
                    translate('auto.components.stats.KimiUsagePane.362231082f', 'Unknown')}
                </td>
                <td className="px-2 py-2 text-muted-foreground">{row.events}</td>
                <td className="px-2 py-2 text-muted-foreground">{formatTokens(row.inputTokens)}</td>
                <td className="px-2 py-2 text-muted-foreground">
                  {formatTokens(row.outputTokens)}
                </td>
                <td className="px-2 py-2 text-muted-foreground">{formatTokens(row.totalTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
