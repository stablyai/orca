import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { UsageApiKeyField } from './UsageApiKeyField'

type CredentialStatus = boolean | 'loading' | 'unavailable'

/** Keeps late initial reads from replacing a completed credential mutation. */
export function OpenCodeGoCredentials({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const t = useTranslate()
  const [draft, setDraft] = useState('')
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>('loading')
  const [busy, setBusy] = useState(false)
  const statusReadGeneration = useRef(0)
  const configured = credentialStatus === true
  useEffect(() => {
    let active = true
    const generation = statusReadGeneration.current
    void window.api.opencodeGoCredentials.getStatus().then(
      (status) => {
        if (active && generation === statusReadGeneration.current) {
          setCredentialStatus(status.apiKeyConfigured)
        }
      },
      () => {
        if (active && generation === statusReadGeneration.current) {
          setCredentialStatus('unavailable')
        }
        console.error('Failed to load OpenCode Go credential status')
      }
    )
    return () => {
      active = false
    }
  }, [])

  const updateCredential = async (clear: boolean): Promise<void> => {
    setBusy(true)
    try {
      const status = clear
        ? await window.api.opencodeGoCredentials.clearApiKey()
        : await window.api.opencodeGoCredentials.saveApiKey(draft.trim())
      statusReadGeneration.current += 1
      setCredentialStatus(status.apiKeyConfigured)
      setDraft('')
      onSaved()
    } catch {
      toast.error(t('sessionHistory.settings.saveError', 'Could not save. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SearchableSetting
      title={t(
        'auto.components.settings.AccountsPane.opencodeGo.apiKey.9447604f08',
        'OpenCode Go API key'
      )}
      description={t(
        'auto.components.settings.AccountsPane.opencodeGo.apiKey.description',
        'Optional override. Orca otherwise uses the key OpenCode saved when you ran /connect, then OPENCODE_API_KEY.'
      )}
      keywords={['opencode', 'go', 'api', 'key', 'connect', 'rate limit', 'status bar']}
      className="space-y-2 py-3"
    >
      <UsageApiKeyField
        inputId="opencode-go-api-key"
        label={t(
          'auto.components.settings.AccountsPane.opencodeGo.apiKey.label',
          'OpenCode Go API key'
        )}
        placeholder={t(
          'auto.components.settings.AccountsPane.opencodeGo.apiKey.placeholder',
          'Leave blank to use the key saved by /connect or OPENCODE_API_KEY'
        )}
        badgeLabel={
          credentialStatus === 'loading'
            ? t('auto.components.settings.AccountsPane.opencodeGo.apiKey.checking', 'Checking…')
            : credentialStatus === 'unavailable'
              ? t(
                  'auto.components.settings.AccountsPane.opencodeGo.apiKey.unavailable',
                  'Status unavailable'
                )
              : configured
                ? t('auto.components.settings.AccountsPane.73ea15f24b', 'Saved')
                : t('auto.components.settings.AccountsPane.23afe8f226', 'Not saved')
        }
        configured={configured}
        draft={draft}
        onDraftChange={setDraft}
        disabled={busy}
        onSave={() => void updateCredential(false)}
        onClear={() => void updateCredential(true)}
      />
      <p className="text-xs text-muted-foreground">
        {t(
          'auto.components.settings.AccountsPane.opencodeGo.apiKey.help',
          'Used for OpenCode Go usage in the status bar. The session cookie below is only needed for legacy console (OpenCode Black) accounts.'
        )}
      </p>
    </SearchableSetting>
  )
}
