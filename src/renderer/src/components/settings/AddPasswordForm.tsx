import { useState } from 'react'
import type { BrowserCredentialEntry } from '../../../../shared/browser-credential-types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

type AddPasswordFormProps = {
  disabled: boolean
  onAdd: (
    origin: string,
    username: string,
    password: string
  ) => Promise<BrowserCredentialEntry | null>
  onAdded: () => void
}

export function AddPasswordForm({
  disabled,
  onAdd,
  onAdded
}: AddPasswordFormProps): React.JSX.Element {
  const [origin, setOrigin] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (): Promise<void> => {
    const trimmedOrigin = origin.trim()
    const trimmedUsername = username.trim()
    if (!trimmedOrigin || !trimmedUsername || !password) {
      return
    }
    setSaving(true)
    try {
      const result = await onAdd(trimmedOrigin, trimmedUsername, password)
      // Why: only clear the form and notify parent on success — null means the
      // vault rejected the entry (e.g. invalid origin); preserve the user's input.
      if (!result) {
        return
      }
      setOrigin('')
      setUsername('')
      setPassword('')
      onAdded()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border/50 bg-muted/20 p-4">
      <h4 className="text-sm font-medium">
        {translate('auto.components.settings.PasswordsPane.add_login_header', 'Add Login')}
      </h4>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="add-pwd-origin">
            {translate('auto.components.settings.PasswordsPane.field_origin', 'Website')}
          </Label>
          <Input
            id="add-pwd-origin"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder={translate(
              'auto.components.settings.PasswordsPane.field_origin_placeholder',
              'https://example.com'
            )}
            disabled={disabled || saving}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="add-pwd-username">
            {translate('auto.components.settings.PasswordsPane.field_username', 'Username')}
          </Label>
          <Input
            id="add-pwd-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={translate(
              'auto.components.settings.PasswordsPane.field_username_placeholder',
              'user@example.com'
            )}
            disabled={disabled || saving}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="add-pwd-password">
            {translate('auto.components.settings.PasswordsPane.field_password', 'Password')}
          </Label>
          <Input
            id="add-pwd-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={translate(
              'auto.components.settings.PasswordsPane.field_password_placeholder',
              '••••••••'
            )}
            disabled={disabled || saving}
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={disabled || saving || !origin.trim() || !username.trim() || !password}
          onClick={() => void handleSubmit()}
        >
          {translate('auto.components.settings.PasswordsPane.add_login_btn', 'Save Login')}
        </Button>
      </div>
    </div>
  )
}
