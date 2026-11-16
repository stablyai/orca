import { useState } from 'react'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { Label } from '../../../ui/label'
import { Textarea } from '../../../ui/textarea'
import { SettingsRow } from '../../form-controls/SettingsFormControls'
import { Switch } from '../../../ui/switch'
import { translate } from '@/i18n/i18n'

type Props = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function ProxyTlsSettingsFields({ settings, updateSettings }: Props): React.JSX.Element {
  const source = settings.httpProxyCaCertificate ?? ''
  const [draft, setDraft] = useState<string | null>(null)
  const [previousSource, setPreviousSource] = useState(source)
  const [error, setError] = useState<string | null>(null)
  if (source !== previousSource) {
    setPreviousSource(source)
    setError(null)
  }

  const save = async (updates: Partial<GlobalSettings>): Promise<void> => {
    const submittedDraft = draft
    setError(null)
    try {
      await updateSettings(updates)
      if (updates.httpProxyCaCertificate !== undefined) {
        setDraft((current) => (current === submittedDraft ? null : current))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="settings-proxy-ca-certificate">
          {translate('settings.network.caCertificate', 'Custom CA certificate (PEM)')}
        </Label>
        <Textarea
          id="settings-proxy-ca-certificate"
          value={draft ?? source}
          onChange={(event) => {
            setDraft(event.target.value)
            setError(null)
          }}
          onBlur={() => {
            const certificate = (draft ?? source).trim()
            if (certificate !== source) {
              void save({ httpProxyCaCertificate: certificate })
            }
          }}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          rows={4}
          maxLength={1024 * 1024}
          aria-invalid={Boolean(error)}
          aria-describedby="settings-proxy-tls-description"
        />
        <p id="settings-proxy-tls-description" className="text-xs text-muted-foreground">
          {translate(
            'settings.network.caDescription',
            'Paste your corporate CA certificates, without private keys. Applies to Cloud sign-in, Relay, and other app integrations. Embedded browsing and terminal commands keep their own TLS settings.'
          )}
        </p>
      </div>
      <SettingsRow
        labelId="settings-proxy-ignore-ssl"
        label={translate('settings.network.ignoreSsl', 'Ignore SSL certificate errors')}
        description={translate(
          'settings.network.ignoreSslDescription',
          'Disables certificate verification for these connections. This can expose your credentials to interception. Leave off when using a trusted CA certificate.'
        )}
        control={
          <Switch
            aria-labelledby="settings-proxy-ignore-ssl"
            checked={settings.httpProxyIgnoreCertificateErrors === true}
            onCheckedChange={(checked) => {
              void save({
                httpProxyIgnoreCertificateErrors: checked
              })
            }}
          />
        }
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </>
  )
}
