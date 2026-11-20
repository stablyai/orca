import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  ServerVaultTarget,
  VaultEntry,
  VaultResult
} from '../../../../../shared/secure-storage/credential-vault'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { CredentialVaultForm } from './CredentialVaultForm'

type Failure = Extract<VaultResult<never>, { ok: false }>

function failureMessage(reason: Failure['reason'], t: Translate, isServer: boolean): string {
  switch (reason) {
    case 'unprotected':
      return isServer
        ? t(
            'settings.credentialVault.serverEncryptionUnavailable',
            'Encryption is unavailable on this server. The vault will not store plaintext credentials.'
          )
        : t(
            'settings.credentialVault.unprotected',
            'The vault needs OS-backed encryption. Unlock or enable your system keyring and try again.'
          )
    case 'forbidden':
      return t(
        'settings.credentialVault.serverAccessRequired',
        'Access is not enabled for this pairing. Create a new link on the server with orca pair --grant-credential-vault, then pair again.'
      )
    case 'unsupported':
      return t(
        'settings.credentialVault.serverUnsupported',
        'This server does not support the vault. Update the server and try again.'
      )
    case 'invalid':
      return t('settings.credentialVault.invalid', 'Check the entry fields and try again.')
    case 'missing':
      return t('settings.credentialVault.missing', 'This entry is no longer in the vault.')
    case 'full':
      return t(
        'settings.credentialVault.full',
        'The vault is full. Delete an entry before adding another.'
      )
    case 'auth-failed':
      return t('settings.credentialVault.authFailed', 'Could not confirm it was you.')
    case 'unavailable':
      return t(
        'settings.credentialVault.unavailable',
        'Orca could not access the vault. Try again.'
      )
  }
}

const unavailable = { ok: false, reason: 'unavailable' } as const

export function CredentialVaultPane({
  server
}: {
  server?: ServerVaultTarget & { name: string }
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const [view, setView] = useState<VaultResult<VaultEntry[]> | null>(null)
  const [form, setForm] = useState<{ entry: VaultEntry | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Failure['reason'] | null>(null)
  const [query, setQuery] = useState('')
  const api = window.api.credentialVault
  const environmentId = server?.environmentId
  const pairingRevision = server?.pairingRevision
  const refresh = useCallback(async () => {
    const target =
      environmentId !== undefined && pairingRevision !== undefined
        ? { environmentId, pairingRevision }
        : undefined
    setView(null)
    setView(await api.list(target).catch(() => unavailable))
  }, [api, environmentId, pairingRevision])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async <T,>(
    operation: () => Promise<VaultResult<T>>,
    success: (value: T) => void
  ): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await operation()
      if (result.ok) {
        success(result.value)
      } else {
        setError(result.reason)
      }
    } catch {
      setError('unavailable')
    }
    setBusy(false)
  }

  const openForm = (entry: VaultEntry | null): void => {
    setError(null)
    setForm({ entry })
  }

  const remove = async (entry: VaultEntry): Promise<void> => {
    const confirmed = await confirm({
      title: t('settings.credentialVault.deleteTitle', 'Delete vault entry?'),
      description: t(
        'settings.credentialVault.deleteDescription',
        'Delete “{{name}}” from this vault? This can’t be undone.',
        { name: entry.name }
      ),
      confirmLabel: t('common.delete', 'Delete'),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      await run(
        () => api.remove(entry.id, server),
        (entries) => setView({ ok: true, value: entries })
      )
    }
  }

  const entries = view?.ok ? view.value : []
  const needle = query.trim().toLowerCase()
  const visibleEntries = entries.filter((entry) =>
    [entry.name, entry.username, entry.website].some((field) =>
      field.toLowerCase().includes(needle)
    )
  )
  const searchLabel = t('settings.credentialVault.search', 'Search entries')

  return (
    <>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {failureMessage(error, t, server !== undefined)}
        </p>
      ) : null}
      {form ? (
        <CredentialVaultForm
          entry={form.entry}
          busy={busy}
          onCancel={() => {
            setForm(null)
            setError(null)
          }}
          onSave={(draft) =>
            void run(
              () => api.save(draft, server),
              (next) => {
                setView({ ok: true, value: next })
                setForm(null)
                setQuery('')
              }
            )
          }
        />
      ) : null}
      <SettingsGroup
        title={t('settings.credentialVault.entries', 'Saved entries')}
        description={
          server
            ? t(
                'settings.credentialVault.serverProtection',
                'Encrypted and saved on {{server}}. Orca does not save a copy in the local vault.',
                { server: server.name }
              )
            : t(
                'settings.credentialVault.protection',
                'Values are encrypted using your system keyring and copied only on request.'
              )
        }
        wrapAction
        action={
          <Button
            type="button"
            size="sm"
            onClick={() => openForm(null)}
            disabled={!view?.ok || busy || !!form}
          >
            <Plus />
            {t('settings.credentialVault.addEntry', 'Add entry')}
          </Button>
        }
      >
        {view === null ? (
          <p role="status" className="py-3 text-sm text-muted-foreground">
            {t('settings.credentialVault.loading', 'Loading vault…')}
          </p>
        ) : !view.ok ? (
          <SettingsRow
            label={t('settings.credentialVault.unavailableTitle', 'Vault unavailable')}
            description={failureMessage(view.reason, t, server !== undefined)}
            control={
              <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
                {t('settings.credentialVault.retry', 'Retry')}
              </Button>
            }
          />
        ) : (
          <>
            {entries.length > 0 ? (
              <div data-settings-row="" className="py-3">
                <Input
                  type="search"
                  aria-label={searchLabel}
                  placeholder={searchLabel}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            ) : null}
            {visibleEntries.length === 0 ? (
              <p data-settings-row="" className="py-3 text-sm text-muted-foreground">
                {entries.length === 0
                  ? t('settings.credentialVault.empty', 'No entries yet.')
                  : t('settings.credentialVault.noMatches', 'No matching entries.')}
              </p>
            ) : null}
            {visibleEntries.map((entry) => (
              <SettingsRow
                key={entry.id}
                label={<span className="break-all">{entry.name}</span>}
                description={
                  <span className="break-all">
                    {entry.kind === 'login'
                      ? [entry.username, entry.website].filter(Boolean).join(' · ') ||
                        t('settings.credentialVault.login', 'Login')
                      : t('settings.credentialVault.secret', 'API key or token')}
                  </span>
                }
                control={
                  <div className="flex flex-wrap gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || !!form}
                      onClick={() =>
                        void run(
                          () => api.copy(entry.id, server),
                          () => {
                            toast.success(
                              t(
                                'settings.credentialVault.copied',
                                'Copied. Orca clears it from the clipboard in one minute if it hasn’t changed.'
                              )
                            )
                          }
                        )
                      }
                    >
                      {entry.kind === 'login'
                        ? t('settings.credentialVault.copyPassword', 'Copy password')
                        : t('settings.credentialVault.copySecret', 'Copy secret')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy || !!form}
                      onClick={() => openForm(entry)}
                    >
                      {t('settings.credentialVault.edit', 'Edit')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy || !!form}
                      onClick={() => void remove(entry)}
                    >
                      {t('common.delete', 'Delete')}
                    </Button>
                  </div>
                }
              />
            ))}
          </>
        )}
      </SettingsGroup>
    </>
  )
}
