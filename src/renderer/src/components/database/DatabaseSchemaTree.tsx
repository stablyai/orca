import { ChevronRight, Table2 } from 'lucide-react'
import type { DatabaseSchemaResult } from '../../../../shared/database-types'
import { translate } from '@/i18n/i18n'

export function DatabaseSchemaTree({
  schema,
  onSelectTable
}: {
  schema: DatabaseSchemaResult | null
  onSelectTable: (schema: string, table: string) => void
}): React.JSX.Element {
  if (!schema) {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        {translate('auto.components.database.schema.connect', 'Connect to load the schema.')}
      </p>
    )
  }
  if (schema.tables.length === 0) {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        {translate('auto.components.database.schema.empty', 'No user tables found.')}
      </p>
    )
  }
  const bySchema = new Map<string, DatabaseSchemaResult['tables']>()
  for (const table of schema.tables) {
    const tables = bySchema.get(table.schema) ?? []
    tables.push(table)
    bySchema.set(table.schema, tables)
  }
  return (
    <div className="scrollbar-sleek h-full overflow-auto py-2">
      {[...bySchema.entries()].map(([schemaName, tables]) => (
        <details key={schemaName} open className="group/schema">
          <summary className="flex cursor-pointer list-none items-center gap-1 px-2 py-1 text-xs font-medium hover:bg-accent">
            <ChevronRight className="size-3 transition-transform group-open/schema:rotate-90" />
            {schemaName}
          </summary>
          {tables.map((table) => (
            <details key={`${table.schema}.${table.name}`} className="group/table">
              <summary className="flex cursor-pointer list-none items-center gap-1 py-1 pr-2 pl-5 text-xs hover:bg-accent">
                <ChevronRight className="size-3 transition-transform group-open/table:rotate-90" />
                <Table2 className="size-3 text-muted-foreground" />
                <button
                  type="button"
                  className="min-w-0 truncate text-left"
                  onClick={(event) => {
                    event.preventDefault()
                    onSelectTable(table.schema, table.name)
                  }}
                >
                  {table.name}
                </button>
              </summary>
              {table.columns.map((column) => (
                <div
                  key={column.name}
                  className="flex items-baseline justify-between gap-2 py-0.5 pr-2 pl-10 text-[11px]"
                >
                  <span className="min-w-0 truncate font-mono">{column.name}</span>
                  <span className="shrink-0 text-muted-foreground">{column.dataType}</span>
                </div>
              ))}
            </details>
          ))}
        </details>
      ))}
    </div>
  )
}
