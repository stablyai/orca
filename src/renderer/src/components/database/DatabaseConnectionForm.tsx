import { Database, Loader2, Plug, Trash2 } from 'lucide-react'
import type {
  DatabaseConnectionConfig,
  DatabaseProfileSummary,
  DatabaseSslMode
} from '../../../../shared/database-types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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

const NEW_PROFILE_VALUE = '__new_database_profile__'

type DatabaseConnectionFormProps = {
  connection: DatabaseConnectionConfig
  idPrefix: string
  password: string
  pending: boolean
  profiles: DatabaseProfileSummary[]
  selectedProfileId?: string
  profileName: string
  rememberPassword: boolean
  selectedProfileHasPassword: boolean
  onChange: (connection: DatabaseConnectionConfig) => void
  onPasswordChange: (password: string) => void
  onProfileSelect: (profileId?: string) => void
  onProfileNameChange: (name: string) => void
  onRememberPasswordChange: (remember: boolean) => void
  onDeleteProfile: () => void
  onConnect: () => void
}

export function DatabaseConnectionForm(props: DatabaseConnectionFormProps): React.JSX.Element {
  const {
    connection,
    idPrefix,
    password,
    pending,
    profiles,
    selectedProfileId,
    profileName,
    rememberPassword,
    selectedProfileHasPassword,
    onChange,
    onPasswordChange,
    onProfileSelect,
    onProfileNameChange,
    onRememberPasswordChange,
    onDeleteProfile,
    onConnect
  } = props
  const patch = (next: Partial<DatabaseConnectionConfig>): void =>
    onChange({ ...connection, ...next })
  const hostId = `${idPrefix}-host`
  const databaseId = `${idPrefix}-name`
  const profileNameId = `${idPrefix}-profile-name`
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
            'Profiles and saved passwords belong to this project node. Passwords stay in its encrypted vault and are never returned to clients.'
          )}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label>{translate('auto.components.database.connection.savedProfile', 'Profile')}</Label>
          <div className="flex gap-2">
            <Select
              value={selectedProfileId ?? NEW_PROFILE_VALUE}
              disabled={pending}
              onValueChange={(value) =>
                onProfileSelect(value === NEW_PROFILE_VALUE ? undefined : value)
              }
            >
              <SelectTrigger className="min-w-0 flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW_PROFILE_VALUE}>
                  {translate('auto.components.database.connection.newProfile', 'New profile')}
                </SelectItem>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={!selectedProfileId || pending}
              aria-label={translate(
                'auto.components.database.connection.deleteProfile',
                'Delete profile'
              )}
              onClick={onDeleteProfile}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor={profileNameId}>
            {translate('auto.components.database.connection.profileName', 'Profile name')}
          </Label>
          <Input
            id={profileNameId}
            value={profileName}
            disabled={pending}
            onChange={(event) => onProfileNameChange(event.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor={hostId}>
            {translate('auto.components.database.connection.host', 'Host')}
          </Label>
          <div className="flex gap-2">
            <Input
              id={hostId}
              value={connection.host}
              disabled={pending}
              onChange={(event) => patch({ host: event.target.value })}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <Input
              aria-label={translate('auto.components.database.connection.port', 'Port')}
              value={String(connection.port)}
              disabled={pending}
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
            disabled={pending}
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
            disabled={pending}
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
            disabled={pending}
            placeholder={
              selectedProfileHasPassword
                ? translate(
                    'auto.components.database.connection.passwordSaved',
                    'Saved in node vault'
                  )
                : undefined
            }
            onChange={(event) => onPasswordChange(event.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="space-y-2">
          <Label>{translate('auto.components.database.connection.tls', 'TLS')}</Label>
          <Select
            value={connection.sslMode}
            disabled={pending}
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
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={rememberPassword}
          disabled={pending}
          onCheckedChange={(checked) => onRememberPasswordChange(checked === true)}
        />
        <span>
          {translate(
            'auto.components.database.connection.rememberPassword',
            'Remember password on this node so every client paired to it can use this profile.'
          )}
        </span>
      </label>
      <Button
        type="button"
        onClick={onConnect}
        disabled={pending || !profileName.trim()}
        className="w-full sm:w-auto"
      >
        {pending ? <Loader2 className="animate-spin" /> : <Plug />}
        {translate('auto.components.database.connection.saveAndConnect', 'Save and connect')}
      </Button>
    </div>
  )
}
