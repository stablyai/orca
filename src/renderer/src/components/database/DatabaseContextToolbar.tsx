import { Database } from 'lucide-react'
import type {
  DatabaseCatalogResult,
  DatabaseConnectionConfig
} from '../../../../shared/database-types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'

const ALL_SCHEMAS = '__all_database_schemas__'

type DatabaseContextToolbarProps = {
  connection: DatabaseConnectionConfig
  catalog: DatabaseCatalogResult | null
  ownerLabel: string
  readOnly: boolean
  pending: boolean
  onDatabaseChange: (database: string) => void
  onSchemaChange: (schema?: string) => void
  onReadOnlyChange: (readOnly: boolean) => void
  onEditConnection: () => void
}

export function DatabaseContextToolbar(props: DatabaseContextToolbarProps): React.JSX.Element {
  const { connection, catalog, ownerLabel, readOnly, pending } = props
  const databases = (catalog?.databases ?? [connection.database]).filter(
    (database) => database.trim().length > 0
  )
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-2 py-1 text-xs">
      <Database className="size-3.5" />
      <Select
        value={connection.database.trim() ? connection.database : undefined}
        onValueChange={props.onDatabaseChange}
        disabled={pending}
      >
        <SelectTrigger className="h-7 w-40 font-mono text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {databases.map((database) => (
            <SelectItem key={database} value={database}>
              {database}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={connection.schema ?? ALL_SCHEMAS}
        onValueChange={(value) => props.onSchemaChange(value === ALL_SCHEMAS ? undefined : value)}
        disabled={pending}
      >
        <SelectTrigger className="h-7 w-40 font-mono text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_SCHEMAS}>
            {translate('auto.components.database.toolbar.allSchemas', 'All schemas')}
          </SelectItem>
          {catalog?.schemas.map((schema) => (
            <SelectItem key={schema} value={schema}>
              {schema}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="min-w-0 truncate text-muted-foreground">{ownerLabel}</span>
      <div className="ml-auto flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <Checkbox
            checked={readOnly}
            disabled={pending}
            onCheckedChange={(checked) => props.onReadOnlyChange(checked === true)}
          />
          {translate('auto.components.database.toolbar.readOnly', 'Read only')}
        </label>
        <Button variant="ghost" size="xs" disabled={pending} onClick={props.onEditConnection}>
          {translate('auto.components.database.toolbar.editConnection', 'Edit connection')}
        </Button>
      </div>
    </div>
  )
}
