import { formatSessionTime, formatTokens } from './usage-formatters'

type UsageRecentSession = {
  sessionId: string
  lastActiveAt: string
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
}

export function UsageRecentSessionsTable<Row extends UsageRecentSession>({
  title,
  description,
  headings,
  unknownModel,
  rows,
  getActivity,
  getTrailingTokens,
  getModelSuffix
}: UsageRecentSessionsTableProps<Row>): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="overflow-x-auto">
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
              <tr key={row.sessionId} className="border-b border-border/40 last:border-b-0">
                <td className="px-2 py-2 text-muted-foreground">
                  {formatSessionTime(row.lastActiveAt)}
                </td>
                <td className="px-2 py-2 text-foreground">{row.projectLabel}</td>
                <td className="px-2 py-2 text-muted-foreground">
                  {row.model ?? unknownModel}
                  {getModelSuffix?.(row)}
                </td>
                <td className="px-2 py-2 text-muted-foreground">{getActivity(row)}</td>
                <td className="px-2 py-2 text-muted-foreground">{formatTokens(row.inputTokens)}</td>
                <td className="px-2 py-2 text-muted-foreground">
                  {formatTokens(row.outputTokens)}
                </td>
                <td className="px-2 py-2 text-muted-foreground">
                  {formatTokens(getTrailingTokens(row))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
