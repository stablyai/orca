import React from 'react'
import { Table2 } from 'lucide-react'
import type { SqliteTableInfo } from '../../../../shared/sqlite-database'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type SqliteTableListProps = {
  tables: SqliteTableInfo[]
  selectedTable: string | null
  onSelect: (table: string) => void
}

export default function SqliteTableList({
  tables,
  selectedTable,
  onSelect
}: SqliteTableListProps): React.JSX.Element {
  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-border/60">
      <div className="border-b border-border/60 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {translate('auto.components.editor.SqliteTableList.heading', 'Tables')}
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-editor py-1">
        {tables.map((table) => (
          <button
            key={table.name}
            type="button"
            onClick={() => onSelect(table.name)}
            aria-current={table.name === selectedTable}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1 text-left text-xs',
              table.name === selectedTable
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/40'
            )}
          >
            <Table2 className="size-3.5 shrink-0" />
            <span className="truncate" title={table.name}>
              {table.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
