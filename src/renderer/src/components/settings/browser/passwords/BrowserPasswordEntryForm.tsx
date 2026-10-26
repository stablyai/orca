import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type {
  BrowserPasswordEntryEditResult,
  BrowserPasswordEntryInput
} from '../../../../../../shared/browser-passwords-types'

/** Editing starts from what the user unlocked with Touch ID; adding starts empty. */
export type BrowserPasswordEntryFormStart =
  | { mode: 'add' }
  | {
      mode: 'edit'
      entryId: string
      site: string
      username: string
      password: string
      note: string
    }

function failureText(
  reason: Exclude<BrowserPasswordEntryEditResult, { ok: true }>['reason']
): string {
  switch (reason) {
    case 'invalid-site':
      return translate(
        'settings.browser.passwords.form.invalidSite',
        'Enter a website address, like example.com.'
      )
    case 'invalid-password':
      return translate('settings.browser.passwords.form.invalidPassword', 'Enter a password.')
    case 'duplicate':
      return translate(
        'settings.browser.passwords.form.duplicate',
        'A password for this username is already saved for this site.'
      )
    case 'unavailable':
      return translate(
        'settings.browser.passwords.form.unavailable',
        'Could not save this password.'
      )
  }
}

export function BrowserPasswordEntryForm({
  browserProfileId,
  start,
  onDone
}: {
  browserProfileId: string
  start: BrowserPasswordEntryFormStart
  onDone: (saved: boolean) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<BrowserPasswordEntryInput>(
    start.mode === 'edit'
      ? { site: start.site, username: start.username, password: start.password, note: start.note }
      : { site: '', username: '', password: '', note: '' }
  )
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (field: keyof BrowserPasswordEntryInput) => (value: string) =>
    setDraft((current) => ({ ...current, [field]: value }))

  const save = async (): Promise<void> => {
    setSaving(true)
    const api = window.api.browserPasswords
    const result =
      start.mode === 'edit'
        ? await api.updateEntry({
            browserProfileId,
            entryId: start.entryId,
            username: draft.username,
            password: draft.password,
            note: draft.note
          })
        : await api.addEntry({ browserProfileId, ...draft })
    setSaving(false)
    if (result.ok) {
      onDone(true)
    } else {
      setError(failureText(result.reason))
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="text-sm font-medium text-foreground">
        {start.mode === 'edit'
          ? translate('settings.browser.passwords.form.editTitle', 'Edit password')
          : translate('settings.browser.passwords.form.addTitle', 'Add new password')}
      </div>
      <div className="space-y-2">
        <Label htmlFor="browser-password-site">
          {translate('settings.browser.passwords.form.site', 'Site')}
        </Label>
        <Input
          id="browser-password-site"
          value={draft.site}
          placeholder={translate('settings.browser.passwords.form.sitePlaceholder', 'example.com')}
          disabled={start.mode === 'edit'}
          onChange={(event) => set('site')(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="browser-password-username">
          {translate('settings.browser.passwords.form.username', 'Username')}
        </Label>
        <Input
          id="browser-password-username"
          value={draft.username}
          autoComplete="off"
          onChange={(event) => set('username')(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="browser-password-password">
          {translate('settings.browser.passwords.form.password', 'Password')}
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="browser-password-password"
            type={showPassword ? 'text' : 'password'}
            value={draft.password}
            autoComplete="new-password"
            onChange={(event) => set('password')(event.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setShowPassword((shown) => !shown)}
            aria-label={
              showPassword
                ? translate('settings.browser.passwords.hide', 'Hide password')
                : translate('settings.browser.passwords.show', 'Show password')
            }
          >
            {showPassword ? <EyeOff /> : <Eye />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.browser.passwords.form.currentHint',
            "Make sure you're saving your current password for this site."
          )}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="browser-password-note">
          {translate('settings.browser.passwords.form.note', 'Note')}
        </Label>
        <Textarea
          id="browser-password-note"
          value={draft.note}
          onChange={(event) => set('note')(event.target.value)}
        />
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => onDone(false)}>
          {translate('settings.browser.passwords.form.cancel', 'Cancel')}
        </Button>
        <Button
          type="submit"
          disabled={saving || !draft.password || (start.mode === 'add' && !draft.site.trim())}
        >
          {translate('settings.browser.passwords.form.save', 'Save')}
        </Button>
      </div>
    </form>
  )
}
