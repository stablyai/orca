import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getCustomRelayServerSearchEntry } from './mobile-settings-search'
import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import {
  DEFAULT_CLOUD_SERVER,
  validateCustomCloudServer,
  type CloudServerConnectionTest,
  type CloudServerSettingsState,
  type CustomCloudServerSettings
} from '../../../../../shared/settings/custom-cloud-server'

export function CustomRelayServerSettings(): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const [state, setState] = useState<CloudServerSettingsState | null>(null)
  const [draft, setDraft] = useState(DEFAULT_CLOUD_SERVER)
  const [pending, setPending] = useState<CustomCloudServerSettings | null>(null)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [result, setResult] = useState<CloudServerConnectionTest | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let mounted = true
    void window.api.orcaProfiles
      .cloudServerSettings()
      .then((settings) => {
        if (mounted) {
          setState(settings)
          setDraft(settings.settings)
        }
      })
      .catch(() => {
        if (mounted) {
          setError(true)
        }
      })
    return () => {
      mounted = false
    }
  }, [])

  const valid = validateCustomCloudServer(draft, state?.allowLoopbackHttp ?? false)
  const changed = state !== null && JSON.stringify(draft) !== JSON.stringify(state.settings)
  const update = (next: Partial<CustomCloudServerSettings>): void => {
    setDraft((previous) => ({ ...previous, ...next }))
    setResult(null)
    setError(false)
  }
  const test = async (): Promise<void> => {
    if (!valid || busy) {
      return
    }
    setBusy('test')
    setError(false)
    setResult(null)
    try {
      setResult(await window.api.orcaProfiles.testCloudServer(valid))
    } catch {
      setError(true)
    }
    setBusy(null)
  }
  const save = async (): Promise<void> => {
    if (!pending || busy || !state) {
      return
    }
    setBusy('save')
    setError(false)
    try {
      const saved = await window.api.orcaProfiles.switchCloudServer(pending)
      setState({ ...state, settings: saved })
      setDraft(saved)
      setPending(null)
      setResult(null)
    } catch {
      setError(true)
    }
    setBusy(null)
  }

  return (
    <SettingsGroup
      title={t('settings.customRelay.title', 'Custom relay server')}
      description={t(
        'settings.customRelay.description',
        'Choose the cloud auth and relay servers used by this desktop. Sign in after applying a change.'
      )}
    >
      <SearchableSetting {...getCustomRelayServerSearchEntry()} className="space-y-4 py-4">
        <SettingsSwitchRow
          label={t('settings.customRelay.enabled', 'Use custom server')}
          checked={draft.enabled}
          disabled={!state || busy !== null}
          onChange={() => update({ enabled: !draft.enabled })}
        />
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-auth`}>
              {t('settings.customRelay.authUrl', 'Auth server URL')}
            </Label>
            <Input
              id={`${id}-auth`}
              type="url"
              value={draft.authServerUrl}
              disabled={!state || busy !== null}
              onChange={(event) => update({ authServerUrl: event.target.value })}
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-client`}>
              {t('settings.customRelay.clientId', 'Client ID')}
            </Label>
            <Input
              id={`${id}-client`}
              value={draft.clientId}
              disabled={!state || busy !== null}
              onChange={(event) => update({ clientId: event.target.value })}
              autoCapitalize="none"
              spellCheck={false}
              maxLength={256}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-relay`}>
              {t('settings.customRelay.relayUrl', 'Relay director URL')}
            </Label>
            <Input
              id={`${id}-relay`}
              type="url"
              value={draft.relayDirectorUrl}
              disabled={!state || busy !== null}
              onChange={(event) => update({ relayDirectorUrl: event.target.value })}
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.customRelay.validation',
            'Use HTTPS URLs and a nonempty client ID. The relay URL must be an origin without a path. URLs cannot contain credentials, queries, or fragments. HTTP is allowed only on localhost, 127.0.0.1, or [::1] in unpackaged builds.'
          )}
        </p>
        {state?.environmentOverrides ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'settings.customRelay.environment',
              'Environment variables override saved settings. Test connection checks the URLs entered here.'
            )}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!state || !valid || busy !== null}
            onClick={() => void test()}
          >
            {busy === 'test'
              ? t('settings.customRelay.testing', 'Testing connection…')
              : t('settings.customRelay.test', 'Test connection')}
          </Button>
          <Button
            size="sm"
            disabled={!valid || !changed || busy !== null}
            onClick={() => setPending(valid)}
          >
            {t('settings.customRelay.apply', 'Apply changes')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!state || busy !== null}
            onClick={() => setPending(DEFAULT_CLOUD_SERVER)}
          >
            {t('settings.customRelay.reset', 'Reset to default')}
          </Button>
        </div>
        <div role="status" aria-live="polite" className="space-y-1 text-xs text-muted-foreground">
          {result ? (
            <>
              <p>
                {result.auth
                  ? t('settings.customRelay.authSuccess', 'Auth server: connected')
                  : t('settings.customRelay.authFailure', 'Auth server: connection failed')}
              </p>
              <p>
                {result.relay
                  ? t('settings.customRelay.relaySuccess', 'Relay director: connected')
                  : t('settings.customRelay.relayFailure', 'Relay director: connection failed')}
              </p>
            </>
          ) : null}
          {!valid && state ? (
            <p className="text-destructive">
              {t(
                'settings.customRelay.invalid',
                'Enter valid server URLs and a client ID before continuing.'
              )}
            </p>
          ) : null}
          {error ? (
            <p className="text-destructive">
              {t(
                'settings.customRelay.error',
                'Could not complete the request. Check the server settings and try again.'
              )}
            </p>
          ) : null}
        </div>
        <Dialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open && busy !== 'save') {
              setPending(null)
            }
          }}
        >
          <DialogContent surface="security">
            <DialogHeader>
              <DialogTitle>
                {t('settings.customRelay.confirmTitle', 'Switch cloud servers?')}
              </DialogTitle>
              <DialogDescription>
                {t(
                  'settings.customRelay.confirmDescription',
                  'This signs you out and disconnects existing mobile relay pairings. Pair those devices again after signing in to the selected server. Local-only pairings are preserved.'
                )}
              </DialogDescription>
            </DialogHeader>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {t(
                  'settings.customRelay.error',
                  'Could not complete the request. Check the server settings and try again.'
                )}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === 'save'}
                onClick={() => setPending(null)}
              >
                {t('settings.customRelay.cancel', 'Cancel')}
              </Button>
              <Button size="sm" disabled={busy === 'save'} onClick={() => void save()}>
                {busy === 'save'
                  ? t('settings.customRelay.saving', 'Switching servers…')
                  : t('settings.customRelay.confirm', 'Switch servers')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SearchableSetting>
    </SettingsGroup>
  )
}
