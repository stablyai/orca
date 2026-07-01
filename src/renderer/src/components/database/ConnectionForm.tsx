import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import type {
  DbConnectionInput,
  DbConnectionSummary,
  DbConnectionUpdate,
  DbEngine,
  DbSslMode
} from '../../../../shared/database-types'
import { DB_DEFAULT_PORT } from '../../../../shared/database-types'
import { ConsentCheckbox, EncryptionWarningBanner } from './connection-encryption-warning'
import { buildInitialState, type SslFieldValue } from './connection-form-defaults'

type ConnectionFormProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  connection?: DbConnectionSummary
}

export function ConnectionForm({
  open,
  onOpenChange,
  connection
}: ConnectionFormProps): React.JSX.Element {
  const addDbConnection = useAppStore((s) => s.addDbConnection)
  const updateDbConnection = useAppStore((s) => s.updateDbConnection)
  const testDbConnection = useAppStore((s) => s.testDbConnection)
  const dbEncryptionStatus = useAppStore((s) => s.dbEncryptionStatus)
  const mountedRef = useMountedRef()

  const [name, setName] = useState('')
  const [engine, setEngine] = useState<DbEngine>('postgres')
  const [host, setHost] = useState('')
  const [port, setPort] = useState(DB_DEFAULT_PORT.postgres.toString())
  const [database, setDatabase] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [ssl, setSsl] = useState<SslFieldValue>('')
  const [readOnly, setReadOnly] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [consentChecked, setConsentChecked] = useState(false)

  // Reset all fields whenever the dialog opens or the target connection changes.
  useEffect(() => {
    if (!open) { return }
    const initial = buildInitialState(connection)
    setName(initial.name)
    setEngine(initial.engine)
    setHost(initial.host)
    setPort(initial.port)
    setDatabase(initial.database)
    setUser(initial.user)
    setPassword('')
    setSsl(initial.ssl)
    setReadOnly(initial.readOnly)
    setConsentChecked(false)
    setSaving(false)
    setTesting(false)
  }, [open, connection])

  // Build the current form fields into a create payload — shared by Test and Save.
  function currentInput(): DbConnectionInput {
    const sslValue: DbSslMode | undefined = ssl === '' ? undefined : ssl
    return {
      name: name.trim(),
      engine,
      host: host.trim(),
      port: parsedPort,
      database: database.trim(),
      user: user.trim(),
      ssl: sslValue,
      readOnly,
      ...(password.trim() ? { password: password.trim() } : {})
    }
  }

  async function handleTest(): Promise<void> {
    if (!isValid || testing) { return }
    setTesting(true)
    try {
      // An empty password field on an existing connection falls back to the
      // stored secret (resolved in the main process), so pass the id along.
      const result = await testDbConnection(currentInput(), connection?.id)
      if (!mountedRef.current) { return }
      if (result.ok) {
        toast.success(
          translate('auto.components.database.ConnectionForm.testSuccess', 'Connection succeeded')
        )
      } else {
        toast.error(result.error.safeMessage)
      }
    } catch {
      if (mountedRef.current) {
        toast.error(
          translate('auto.components.database.ConnectionForm.testError', 'Test failed')
        )
      }
    } finally {
      if (mountedRef.current) { setTesting(false) }
    }
  }

  function handleEngineChange(value: string): void {
    const next = value as DbEngine
    const prevDefault = DB_DEFAULT_PORT[engine].toString()
    // Auto-advance port only when the user hasn't customised it away from the previous default.
    if (port === prevDefault) {
      setPort(DB_DEFAULT_PORT[next].toString())
    }
    setEngine(next)
  }

  const parsedPort = parseInt(port, 10)
  const isValidPort = !Number.isNaN(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
  const isValid =
    name.trim().length > 0 &&
    host.trim().length > 0 &&
    database.trim().length > 0 &&
    user.trim().length > 0 &&
    isValidPort

  const isWeakEncryption = dbEncryptionStatus !== null && !dbEncryptionStatus.isStrong

  // "entering/keeping a password": create → any password text; edit → text entered OR existing secret kept.
  const hasPasswordIntent =
    password.trim().length > 0 || (connection !== undefined && (connection.hasPassword || false))

  const needsConsent = isWeakEncryption && hasPasswordIntent
  const saveEnabled = isValid && !saving && (!needsConsent || consentChecked)

  const isEditMode = connection !== undefined
  const dialogTitle = isEditMode
    ? translate('auto.components.database.ConnectionForm.titleEdit', 'Edit connection')
    : translate('auto.components.database.ConnectionForm.titleCreate', 'Add connection')
  const dialogDescription = isEditMode
    ? translate(
        'auto.components.database.ConnectionForm.descriptionEdit',
        'Update the database connection settings.'
      )
    : translate(
        'auto.components.database.ConnectionForm.descriptionCreate',
        'Configure a new database connection.'
      )

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!saveEnabled) { return }
    setSaving(true)
    try {
      // An omitted password leaves the stored secret unchanged (store contract).
      await (isEditMode
        ? updateDbConnection(connection.id, currentInput() as DbConnectionUpdate)
        : addDbConnection(currentInput()))

      if (mountedRef.current) {
        onOpenChange(false)
      }
    } catch (error) {
      console.error('Failed to save connection:', error)
      if (mountedRef.current) {
        toast.error(
          isEditMode
            ? translate(
                'auto.components.database.ConnectionForm.errorUpdate',
                'Failed to update connection'
              )
            : translate(
                'auto.components.database.ConnectionForm.errorCreate',
                'Failed to add connection'
              )
        )
        setSaving(false)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        {/* Warn-and-store banner: visible whenever the OS lacks a strong secret store. */}
        {isWeakEncryption ? <EncryptionWarningBanner /> : null}

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="conn-name">
              {translate('auto.components.database.ConnectionForm.labelName', 'Name')}
            </Label>
            <Input
              id="conn-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={translate(
                'auto.components.database.ConnectionForm.namePlaceholder',
                'My database'
              )}
              autoComplete="off"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="conn-engine">
                {translate('auto.components.database.ConnectionForm.labelEngine', 'Engine')}
              </Label>
              <Select value={engine} onValueChange={handleEngineChange}>
                <SelectTrigger id="conn-engine" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="postgres">
                    {translate(
                      'auto.components.database.ConnectionForm.enginePostgres',
                      'Postgres'
                    )}
                  </SelectItem>
                  <SelectItem value="mysql">
                    {translate('auto.components.database.ConnectionForm.engineMysql', 'MySQL')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="conn-ssl">
                {translate('auto.components.database.ConnectionForm.labelSsl', 'SSL')}
              </Label>
              <Select
                value={ssl}
                onValueChange={(value) => setSsl(value as SslFieldValue)}
              >
                <SelectTrigger id="conn-ssl" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">
                    {translate(
                      'auto.components.database.ConnectionForm.sslAuto',
                      'Auto (smart by host)'
                    )}
                  </SelectItem>
                  <SelectItem value="disable">
                    {translate('auto.components.database.ConnectionForm.sslDisable', 'Disable')}
                  </SelectItem>
                  <SelectItem value="verify-full">
                    {translate(
                      'auto.components.database.ConnectionForm.sslVerifyFull',
                      'Verify full'
                    )}
                  </SelectItem>
                  <SelectItem value="insecure-no-verify">
                    {translate(
                      'auto.components.database.ConnectionForm.sslInsecure',
                      'Insecure — no verify'
                    )}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-[1fr_100px] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="conn-host">
                {translate('auto.components.database.ConnectionForm.labelHost', 'Host')}
              </Label>
              <Input
                id="conn-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder={translate(
                  'auto.components.database.ConnectionForm.hostPlaceholder',
                  'localhost'
                )}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="conn-port">
                {translate('auto.components.database.ConnectionForm.labelPort', 'Port')}
              </Label>
              <Input
                id="conn-port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                min={1}
                max={65535}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="conn-database">
              {translate('auto.components.database.ConnectionForm.labelDatabase', 'Database')}
            </Label>
            <Input
              id="conn-database"
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="conn-user">
              {translate('auto.components.database.ConnectionForm.labelUser', 'User')}
            </Label>
            <Input
              id="conn-user"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              autoComplete="off"
            />
          </div>

          {/* Password — write-only; in edit mode never pre-fills the stored secret. */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="conn-password">
              {translate('auto.components.database.ConnectionForm.labelPassword', 'Password')}
            </Label>
            <Input
              id="conn-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                isEditMode && connection.hasPassword
                  ? translate(
                      'auto.components.database.ConnectionForm.passwordPlaceholderEdit',
                      '•••••• (unchanged — type to replace)'
                    )
                  : undefined
              }
              autoComplete="new-password"
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="conn-readonly"
              checked={readOnly}
              onCheckedChange={(checked) => setReadOnly(checked === true)}
            />
            <Label htmlFor="conn-readonly" className="cursor-pointer font-normal">
              {translate('auto.components.database.ConnectionForm.labelReadOnly', 'Read-only')}
            </Label>
          </div>

          {/* Consent required when weak encryption backend AND a password will be stored. */}
          {needsConsent ? (
            <ConsentCheckbox
              checked={consentChecked}
              onCheckedChange={setConsentChecked}
            />
          ) : null}

          <DialogFooter className="pt-2 sm:justify-between">
            <Button
              type="button"
              variant="secondary"
              disabled={!isValid || testing || saving}
              onClick={() => void handleTest()}
            >
              {testing
                ? translate('auto.components.database.ConnectionForm.testing', 'Testing…')
                : translate('auto.components.database.ConnectionForm.test', 'Test connection')}
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => onOpenChange(false)}
              >
                {translate('auto.components.database.ConnectionForm.cancel', 'Cancel')}
              </Button>
              <Button type="submit" disabled={!saveEnabled}>
                {translate('auto.components.database.ConnectionForm.save', 'Save')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
