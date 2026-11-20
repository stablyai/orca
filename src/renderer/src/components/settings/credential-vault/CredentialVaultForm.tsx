import { useId, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import {
  CREDENTIAL_VAULT_LIMITS as limits,
  type VaultEntry,
  type VaultEntryDraft
} from '../../../../../shared/secure-storage/credential-vault'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'

export function CredentialVaultForm({
  entry,
  busy,
  onSave,
  onCancel
}: {
  entry: VaultEntry | null
  busy: boolean
  onSave: (draft: VaultEntryDraft) => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const [kind, setKind] = useState<VaultEntry['kind']>(entry?.kind ?? 'login')
  const [invalidName, setInvalidName] = useState(false)
  const isLogin = kind === 'login'
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) {
      return
    }
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    if (!name) {
      setInvalidName(true)
      event.currentTarget.querySelector<HTMLInputElement>('input[name="name"]')?.focus()
      return
    }
    const value = String(form.get('value') ?? '')
    onSave({
      id: entry?.id,
      name,
      kind,
      username: isLogin ? String(form.get('username') ?? '') : '',
      website: isLogin ? String(form.get('website') ?? '') : '',
      value: value || undefined
    })
  }

  return (
    <form
      autoComplete="off"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && !busy) {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <SettingsGroup
        title={
          entry
            ? t('settings.credentialVault.editEntry', 'Edit entry')
            : t('settings.credentialVault.addEntry', 'Add entry')
        }
      >
        {!entry ? (
          <SettingsRow
            label={t('settings.credentialVault.kind', 'Type')}
            htmlFor={`${id}-kind`}
            control={
              <Select
                value={kind}
                disabled={busy}
                onValueChange={(value) => setKind(value === 'secret' ? 'secret' : 'login')}
              >
                <SelectTrigger id={`${id}-kind`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="login">
                    {t('settings.credentialVault.login', 'Login')}
                  </SelectItem>
                  <SelectItem value="secret">
                    {t('settings.credentialVault.secret', 'API key or token')}
                  </SelectItem>
                </SelectContent>
              </Select>
            }
          />
        ) : null}
        <SettingsRow
          label={t('settings.credentialVault.name', 'Name')}
          htmlFor={`${id}-name`}
          control={
            <Input
              id={`${id}-name`}
              name="name"
              defaultValue={entry?.name}
              maxLength={limits.name}
              onChange={() => setInvalidName(false)}
              aria-invalid={invalidName}
              disabled={busy}
              required
              autoFocus
            />
          }
        />
        {isLogin ? (
          <>
            <SettingsRow
              label={t('settings.credentialVault.username', 'Username')}
              htmlFor={`${id}-username`}
              control={
                <Input
                  id={`${id}-username`}
                  name="username"
                  defaultValue={entry?.username}
                  maxLength={limits.username}
                  disabled={busy}
                />
              }
            />
            <SettingsRow
              label={t('settings.credentialVault.website', 'Website')}
              htmlFor={`${id}-website`}
              control={
                <Input
                  id={`${id}-website`}
                  name="website"
                  defaultValue={entry?.website}
                  maxLength={limits.website}
                  disabled={busy}
                />
              }
            />
          </>
        ) : null}
        <SettingsRow
          label={
            isLogin
              ? t('settings.credentialVault.password', 'Password')
              : t('settings.credentialVault.secretValue', 'Secret')
          }
          htmlFor={`${id}-value`}
          description={
            entry
              ? t('settings.credentialVault.keepValue', 'Leave blank to keep the saved value.')
              : undefined
          }
          control={
            <Input
              key={kind}
              id={`${id}-value`}
              name="value"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={limits.value}
              disabled={busy}
              required={!entry}
            />
          }
        />
        <div data-settings-row="" className="flex justify-end gap-2 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t('settings.credentialVault.cancel', 'Cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {t('settings.credentialVault.save', 'Save')}
          </Button>
        </div>
      </SettingsGroup>
    </form>
  )
}
