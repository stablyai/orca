import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import type {
  BrowserCredentialEntry,
  BrowserCredentialVaultStatus
} from '../../../../shared/browser-credential-types'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { getPasswordsPaneSearchEntries } from './passwords-search'
import { PasswordRow } from './PasswordRow'
import { AddPasswordForm } from './AddPasswordForm'
import { translate } from '@/i18n/i18n'

export { getPasswordsPaneSearchEntries }

type PasswordsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function PasswordsPane({ settings, updateSettings }: PasswordsPaneProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const confirm = useConfirmationDialog()

  const [vaultStatus, setVaultStatus] = useState<BrowserCredentialVaultStatus | null>(null)
  const [entries, setEntries] = useState<BrowserCredentialEntry[]>([])
  const [loadingEntries, setLoadingEntries] = useState(false)

  // Why: check vault availability on mount so add/save controls are disabled when
  // safeStorage is unavailable — never persist plaintext without OS keychain backing.
  useEffect(() => {
    let stale = false
    void window.api.browser.credentials.status().then((status) => {
      if (!stale && mountedRef.current) {
        setVaultStatus(status)
      }
    })
    return () => {
      stale = true
    }
  }, [mountedRef])

  // Why: stable reference via useCallback so the mount effect can declare loadEntries
  // as a dependency without triggering a re-run on every render.
  const loadEntries = useCallback((): void => {
    setLoadingEntries(true)
    void window.api.browser.credentials.list().then((list) => {
      if (mountedRef.current) {
        setEntries(list)
        setLoadingEntries(false)
      }
    })
  }, [mountedRef])

  // Why: run once on mount; mutations call loadEntries() manually after completing.
  useEffect(() => {
    loadEntries()
  }, [loadEntries])

  const vaultUnavailable = vaultStatus !== null && !vaultStatus.available

  const handleAdd = async (
    origin: string,
    username: string,
    password: string
  ): Promise<BrowserCredentialEntry | null> => {
    return window.api.browser.credentials.add({ origin, username, password })
  }

  const handleUpdate = async (
    id: string,
    username: string,
    password: string
  ): Promise<BrowserCredentialEntry | null> => {
    return window.api.browser.credentials.update({
      id,
      username: username || undefined,
      password: password || undefined
    })
  }

  const handleDelete = async (entry: BrowserCredentialEntry): Promise<void> => {
    const confirmed = await confirm({
      title: translate(
        'auto.components.settings.PasswordsPane.delete_confirm_title',
        'Delete login?'
      ),
      description: translate(
        'auto.components.settings.PasswordsPane.delete_confirm_description',
        'This will permanently remove the saved login for {{value0}}.',
        { value0: entry.hostname }
      ),
      confirmLabel: translate(
        'auto.components.settings.PasswordsPane.delete_confirm_btn',
        'Delete'
      ),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      await window.api.browser.credentials.delete(entry.id)
      loadEntries()
    }
  }

  return (
    <div className="space-y-4">
      {/* Master toggle */}
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={translate(
            'auto.components.settings.PasswordsPane.autofill_section_title',
            'Password Autofill'
          )}
          description={translate(
            'auto.components.settings.PasswordsPane.autofill_section_description',
            'Automatically fill saved usernames and passwords in the built-in browser.'
          )}
        />
        <SearchableSetting
          title={translate(
            'auto.components.settings.passwords.search.autofill_title',
            'Password Autofill'
          )}
          description={translate(
            'auto.components.settings.passwords.search.autofill_description',
            'Enable or disable automatic password filling in the built-in browser.'
          )}
          id="passwords-autofill-toggle"
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.PasswordsPane.autofill_toggle_label',
              'Enable password autofill'
            )}
            description={translate(
              'auto.components.settings.PasswordsPane.autofill_toggle_description',
              'Suggests and fills saved logins when visiting matching sites.'
            )}
            checked={Boolean(settings.browserPasswordAutofillEnabled)}
            onChange={() =>
              updateSettings({
                browserPasswordAutofillEnabled: !settings.browserPasswordAutofillEnabled
              })
            }
          />
        </SearchableSetting>
      </section>

      {/* Vault unavailability warning */}
      {vaultUnavailable ? (
        <div className="flex items-start gap-3 rounded-md border border-border/50 bg-muted/30 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-0.5">
            <p className="font-medium">
              {translate(
                'auto.components.settings.PasswordsPane.vault_unavailable_title',
                'Secure storage unavailable'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {vaultStatus?.reason ??
                translate(
                  'auto.components.settings.PasswordsPane.vault_unavailable_fallback',
                  'Passwords cannot be saved without OS keychain support.'
                )}
            </p>
          </div>
        </div>
      ) : null}

      {/* Saved logins list */}
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={translate(
            'auto.components.settings.PasswordsPane.saved_logins_title',
            'Saved Logins'
          )}
          description={translate(
            'auto.components.settings.PasswordsPane.saved_logins_description',
            'Manage usernames and passwords stored by Orca.'
          )}
        />
        {loadingEntries ? (
          <p className="text-xs text-muted-foreground">
            {translate('auto.components.settings.PasswordsPane.loading', 'Loading…')}
          </p>
        ) : entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate('auto.components.settings.PasswordsPane.empty_list', 'No saved logins yet.')}
          </p>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => (
              <PasswordRow
                key={entry.id}
                entry={entry}
                disabled={vaultUnavailable}
                onReveal={(id) => window.api.browser.credentials.reveal(id)}
                onUpdate={async (id, username, password) => {
                  const result = await handleUpdate(id, username, password)
                  loadEntries()
                  return result
                }}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </section>

      {/* Add login form */}
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.PasswordsPane.add_section_title', 'Add Login')}
          description={translate(
            'auto.components.settings.PasswordsPane.add_section_description',
            'Manually add a login to the vault.'
          )}
        />
        <AddPasswordForm disabled={vaultUnavailable} onAdd={handleAdd} onAdded={loadEntries} />
      </section>
    </div>
  )
}
