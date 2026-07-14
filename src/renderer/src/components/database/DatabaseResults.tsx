import type { DatabaseQueryResult } from '../../../../shared/database-types'
import { translate } from '@/i18n/i18n'

export function DatabaseResults({
  result
}: {
  result: DatabaseQueryResult | null
}): React.JSX.Element {
  if (!result) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {translate('auto.components.database.results.empty', 'Run a query to see results.')}
      </div>
    )
  }
  if (result.columns.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        {translate(
          'auto.components.database.results.summary',
          '{{value0}} · {{value1}} rows · {{value2}} ms',
          {
            value0:
              result.command ||
              translate('auto.components.database.results.complete', 'Query complete'),
            value1: result.rowCount ?? 0,
            value2: result.durationMs
          }
        )}
      </div>
    )
  }
  return (
    <div className="scrollbar-editor h-full overflow-auto">
      <table className="min-w-full border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            <th className="border-r border-b border-border px-2 py-1.5 text-right font-medium text-muted-foreground">
              #
            </th>
            {result.columns.map((column, index) => (
              <th
                key={`${column.name}-${index}`}
                className="min-w-32 border-r border-b border-border px-2 py-1.5 text-left font-medium"
              >
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="hover:bg-accent/50">
              <td className="border-r border-b border-border px-2 py-1 text-right text-muted-foreground tabular-nums">
                {rowIndex + 1}
              </td>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="max-w-96 border-r border-b border-border px-2 py-1 font-mono whitespace-pre-wrap"
                >
                  {cell === null ? (
                    <span className="text-muted-foreground italic">
                      {translate('auto.components.database.results.null', 'NULL')}
                    </span>
                  ) : (
                    String(cell)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
