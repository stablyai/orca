import { Database, Loader2, Plug } from 'lucide-react'
import type { DatabaseConnectionConfig, DatabaseSslMode } from '../../../../shared/database-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'

export function DatabaseConnectionForm({
  connection,
  idPrefix,
  password,
  pending,
  onChange,
  onPasswordChange,
  onConnect
}: {
  connection: DatabaseConnectionConfig
  idPrefix: string
  password: string
  pending: boolean
  onChange: (connection: DatabaseConnectionConfig) => void
  onPasswordChange: (password: string) => void
  onConnect: () => void
}): React.JSX.Element {
  const patch = (next: Partial<DatabaseConnectionConfig>): void =>
    onChange({ ...connection, ...next })
  const hostId = `${idPrefix}-host`
  const databaseId = `${idPrefix}-name`
  const userId = `${idPrefix}-user`
  const passwordId = `${idPrefix}-password`

  return (
    <div className="m-auto w-full max-w-2xl space-y-5 rounded-xl border border-border bg-card p-6 shadow-xs">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Database className="size-4" />
          {translate('auto.components.database.connection.title', 'PostgreSQL connection')}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.database.connection.description',
            'The query runs on the runtime that owns this project. The password stays in memory and is never saved with the tab.'
          )}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor={hostId}>
            {translate('auto.components.database.connection.host', 'Host')}
          </Label>
          <div className="flex gap-2">
            <Input
              id={hostId}
              value={connection.host}
              onChange={(event) => patch({ host: event.target.value })}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <Input
              aria-label={translate('auto.components.database.connection.port', 'Port')}
              value={String(connection.port)}
              onChange={(event) => {
                const port = Number(event.target.value)
                if (Number.isInteger(port) && port > 0 && port <= 65_535) {
                  patch({ port })
                }
              }}
              inputMode="numeric"
              className="w-28 font-mono"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={databaseId}>
            {translate('auto.components.database.connection.database', 'Database')}
          </Label>
          <Input
            id={databaseId}
            value={connection.database}
            onChange={(event) => patch({ database: event.target.value })}
            autoComplete="off"
            className="font-mono"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={userId}>
            {translate('auto.components.database.connection.user', 'User')}
          </Label>
          <Input
            id={userId}
            value={connection.user}
            onChange={(event) => patch({ user: event.target.value })}
            autoComplete="username"
            className="font-mono"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={passwordId}>
            {translate('auto.components.database.connection.password', 'Password')}
          </Label>
          <Input
            id={passwordId}
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label>{translate('auto.components.database.connection.tls', 'TLS')}</Label>
          <Select
            value={connection.sslMode}
            onValueChange={(value) => patch({ sslMode: value as DatabaseSslMode })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="disable">
                {translate('auto.components.database.connection.tlsDisabled', 'Disabled')}
              </SelectItem>
              <SelectItem value="require">
                {translate('auto.components.database.connection.tlsRequired', 'Required')}
              </SelectItem>
              <SelectItem value="verify-full">
                {translate('auto.components.database.connection.tlsVerify', 'Verify certificate')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button type="button" onClick={onConnect} disabled={pending} className="w-full sm:w-auto">
        {pending ? <Loader2 className="animate-spin" /> : <Plug />}
        {translate('auto.components.database.connection.connect', 'Test and connect')}
      </Button>
    </div>
  )
}
