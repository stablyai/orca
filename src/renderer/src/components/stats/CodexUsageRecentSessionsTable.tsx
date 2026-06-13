import type { CodexUsageSessionRow } from '../../../../shared/codex-usage-types'
import { translate } from '@/i18n/i18n'
import { formatSessionTime, formatTokens } from './usage-formatters'

export function CodexUsageRecentSessionsTable({
  recentSessions
}: {
  recentSessions: CodexUsageSessionRow[]
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">
          {translate('auto.components.stats.CodexUsagePane.0cb0983c07', 'Recent sessions')}
        </h4>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.stats.CodexUsagePane.0bd8655475',
            'Most recent local Codex sessions in this scope.'
          )}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.CodexUsagePane.0c36b100be', 'Last active')}
              </th>
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.CodexUsagePane.1a65900aea', 'Project')}
              </th>
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.CodexUsagePane.c2478bcc3c', 'Model')}
              </th>
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.CodexUsagePane.bd0822ca47', 'Events')}
              </th>
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.CodexUsagePane.3acc582214', 'Input')}
              </th>
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.CodexUsagePane.bbd20344b8', 'Output')}
              </th>
              <th className="px-2 py-2 font-medium">
                {translate('auto.components.stats.CodexUsagePane.e0b988599d', 'Total')}
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
                    translate('auto.components.stats.CodexUsagePane.bf6cf2d4dd', 'Unknown')}
                  {row.hasInferredPricing ? ' *' : ''}
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
