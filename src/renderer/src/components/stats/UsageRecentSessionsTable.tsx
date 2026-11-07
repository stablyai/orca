import { Fragment, useState } from 'react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import { formatSessionTime, formatTokens } from './usage-formatters'

type UsageRecentSession = {
  sessionId: string
  lastActiveAt: string
  lastActiveDay?: string
  totalsScope?: 'lifetime' | 'selection'
  projectLabel: string
  model: string | null
  inputTokens: number
  outputTokens: number
}

type UsageRecentSessionHeadings = readonly [
  lastActive: string,
  project: string,
  model: string,
  activity: string,
  input: string,
  output: string,
  trailing: string
]

type UsageRecentSessionsTableProps<Row extends UsageRecentSession> = {
  title: React.ReactNode
  description: React.ReactNode
  headings: UsageRecentSessionHeadings
  unknownModel: string
  rows: readonly Row[]
  getActivity: (row: Row) => number
  getTrailingTokens: (row: Row) => number
  getModelSuffix?: (row: Row) => React.ReactNode
  getSessionTimeLabel?: (row: Row) => string
  renderDetails?: (row: Row) => React.ReactNode
}

export function UsageRecentSessionsTable<Row extends UsageRecentSession>({
  title,
  description,
  headings,
  unknownModel,
  rows,
  getActivity,
  getTrailingTokens,
  getModelSuffix,
  getSessionTimeLabel,
  renderDetails
}: UsageRecentSessionsTableProps<Row>): React.JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <p className="text-xs text-muted-foreground">{description}</p>
        {rows.some((row) => row.totalsScope === 'lifetime') ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'stats.usage.session.lifetime',
              'Some session rows show lifetime totals because period attribution is unavailable. Refresh the scan to rebuild their detail.'
            )}
          </p>
        ) : null}
      </div>
      <div className="overflow-x-auto scrollbar-sleek">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
              {headings.map((heading) => (
                <th key={heading} className="px-2 py-2 font-medium">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.sessionId}>
                <tr key={row.sessionId} className="border-b border-border/40 last:border-b-0">
                  <td className="px-2 py-2 text-muted-foreground">
                    {renderDetails ? (
                      <Button
                        variant="link"
                        size="xs"
                        className="h-auto"
                        aria-expanded={expanded === row.sessionId}
                        onClick={() =>
                          setExpanded(expanded === row.sessionId ? null : row.sessionId)
                        }
                      >
                        {getSessionTimeLabel?.(row) ??
                          row.lastActiveDay ??
                          formatSessionTime(row.lastActiveAt)}
                      </Button>
                    ) : (
                      (getSessionTimeLabel?.(row) ??
                      row.lastActiveDay ??
                      formatSessionTime(row.lastActiveAt))
                    )}
                  </td>
                  <td className="px-2 py-2 text-foreground">{row.projectLabel}</td>
                  <td className="px-2 py-2 text-muted-foreground">
                    {row.model ?? unknownModel}
                    {getModelSuffix?.(row)}
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">{getActivity(row)}</td>
                  <td className="px-2 py-2 text-muted-foreground">
                    {formatTokens(row.inputTokens)}
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">
                    {formatTokens(row.outputTokens)}
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">
                    {formatTokens(getTrailingTokens(row))}
                  </td>
                </tr>
                {expanded === row.sessionId && renderDetails ? (
                  <tr>
                    <td colSpan={7} className="bg-muted/30 px-2 py-3">
                      {renderDetails(row)}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
