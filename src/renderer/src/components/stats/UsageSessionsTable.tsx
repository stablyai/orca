import { translate } from '@/i18n/i18n'
import { formatTokens } from './usage-formatters'

export type UsageSessionRow = {
  sessionId: string
  lastActiveAt: string
  projectLabel: string
  model: string | null
  events?: number
  turns?: number
  inputTokens: number
  outputTokens: number
  cacheTokens?: number
  totalTokens?: number
  hasInferredPricing?: boolean
}

function formatSessionTime(timestamp: string): string {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return timestamp
  }
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

type UsageSessionsTableProps = {
  sessions: UsageSessionRow[]
  eventsColumn?: 'events' | 'turns'
  tokensColumn?: 'cache' | 'total'
}

export function UsageSessionsTable({
  sessions,
  eventsColumn = 'events',
  tokensColumn = 'total'
}: UsageSessionsTableProps): React.JSX.Element {
  const eventsLabel =
    eventsColumn === 'turns'
      ? translate('auto.components.stats.UsageSessionsTable.1afc25eb06', 'Turns')
      : translate('auto.components.stats.UsageSessionsTable.0f03975d59', 'Events')
  const tokensLabel =
    tokensColumn === 'cache'
      ? translate('auto.components.stats.UsageSessionsTable.21ea00bfa8', 'Cache')
      : translate('auto.components.stats.UsageSessionsTable.e0b988599d', 'Total')

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
            <th className="px-2 py-2 font-medium">
              {translate('auto.components.stats.UsageSessionsTable.01476891c7', 'Last active')}
            </th>
            <th className="px-2 py-2 font-medium">
              {translate('auto.components.stats.UsageSessionsTable.c17bed0416', 'Project')}
            </th>
            <th className="px-2 py-2 font-medium">
              {translate('auto.components.stats.UsageSessionsTable.f6a2c8d019', 'Model')}
            </th>
            <th className="px-2 py-2 font-medium">{eventsLabel}</th>
            <th className="px-2 py-2 font-medium">
              {translate('auto.components.stats.UsageSessionsTable.faf3444859', 'Input')}
            </th>
            <th className="px-2 py-2 font-medium">
              {translate('auto.components.stats.UsageSessionsTable.a8b7487ff7', 'Output')}
            </th>
            <th className="px-2 py-2 font-medium">{tokensLabel}</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((row) => (
            <tr key={row.sessionId} className="border-b border-border/40 last:border-b-0">
              <td className="px-2 py-2 text-muted-foreground">
                {formatSessionTime(row.lastActiveAt)}
              </td>
              <td className="px-2 py-2 text-foreground">{row.projectLabel}</td>
              <td className="px-2 py-2 text-muted-foreground">
                {row.model ??
                  translate('auto.components.stats.UsageSessionsTable.cfe2282ffa', 'Unknown')}
                {row.hasInferredPricing ? ' *' : ''}
              </td>
              <td className="px-2 py-2 text-muted-foreground">
                {eventsColumn === 'turns' ? row.turns : row.events}
              </td>
              <td className="px-2 py-2 text-muted-foreground">{formatTokens(row.inputTokens)}</td>
              <td className="px-2 py-2 text-muted-foreground">{formatTokens(row.outputTokens)}</td>
              <td className="px-2 py-2 text-muted-foreground">
                {formatTokens(
                  tokensColumn === 'cache'
                    ? (row.cacheTokens ?? 0)
                    : (row.totalTokens ?? row.inputTokens + row.outputTokens)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
