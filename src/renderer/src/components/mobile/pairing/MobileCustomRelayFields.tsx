// @protected-copy: preserve copy used by security settings.
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import type { useCustomRelayServer } from './use-custom-relay-server'

type CustomRelayServer = ReturnType<typeof useCustomRelayServer>

export function MobileCustomRelayFields({
  server,
  onApply
}: {
  server: CustomRelayServer
  onApply: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const { draft, busy, result, error } = server
  const disabled = !draft || busy !== null

  return (
    <div
      className="space-y-3 border-t border-border/60 bg-accent/40 py-3 pl-10 pr-3"
      data-testid="own-relay-fields"
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-auth`}>{t('settings.customRelay.authUrl', 'Auth server URL')}</Label>
        <Input
          id={`${id}-auth`}
          type="url"
          surface="background"
          density="compact"
          value={draft?.authServerUrl ?? ''}
          placeholder={t('settings.customRelay.authUrlPlaceholder', 'https://login.example.com')}
          disabled={disabled}
          onChange={(event) => server.update({ authServerUrl: event.target.value })}
          aria-describedby={`${id}-auth-hint`}
          autoCapitalize="none"
          spellCheck={false}
        />
        <p id={`${id}-auth-hint`} className="text-xs text-muted-foreground">
          {t(
            'settings.customRelay.authUrlHint',
            'The Orca sign-in service (relay-auth), not your identity provider. Usually the same origin as the relay.'
          )}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-client`}>{t('settings.customRelay.clientId', 'Client ID')}</Label>
        <Input
          id={`${id}-client`}
          surface="background"
          density="compact"
          value={draft?.clientId ?? ''}
          disabled={disabled}
          onChange={(event) => server.update({ clientId: event.target.value })}
          aria-describedby={`${id}-client-hint`}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={256}
        />
        <p id={`${id}-client-hint`} className="text-xs text-muted-foreground">
          {t(
            'settings.customRelay.clientIdHint',
            "Must match the sign-in service's ORCA_AUTH_CLIENT_ID (orca-desktop unless changed)."
          )}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-relay`}>
          {t('settings.customRelay.relayUrl', 'Relay director URL')}
        </Label>
        <Input
          id={`${id}-relay`}
          type="url"
          surface="background"
          density="compact"
          value={draft?.relayDirectorUrl ?? ''}
          placeholder={t('settings.customRelay.relayUrlPlaceholder', 'https://relay.example.com')}
          disabled={disabled}
          onChange={(event) => server.update({ relayDirectorUrl: event.target.value })}
          autoCapitalize="none"
          spellCheck={false}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'settings.customRelay.validation',
          'Use HTTPS URLs and a nonempty client ID. Both URLs must be origins without a path. URLs cannot contain credentials, queries, or fragments. HTTP is allowed only on localhost, 127.0.0.1, or [::1] in unpackaged builds.'
        )}
      </p>
      {server.environmentOverrides ? (
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
          disabled={!server.valid || busy !== null}
          onClick={() => void server.test()}
        >
          {busy === 'test'
            ? t('settings.customRelay.testing', 'Testing connection…')
            : t('settings.customRelay.test', 'Test connection')}
        </Button>
        <Button size="sm" disabled={!server.canApply} onClick={onApply}>
          {server.active
            ? t('settings.customRelay.apply', 'Apply changes')
            : t('settings.customRelay.useServer', 'Use this server')}
        </Button>
      </div>
      <div role="status" aria-live="polite" className="space-y-1 text-xs text-muted-foreground">
        {result ? (
          <>
            <p>
              {result.auth
                ? t('settings.customRelay.authSuccess', 'Auth server: connected')
                : t(
                    'settings.customRelay.authFailure',
                    'Auth server: no Orca sign-in service found at this URL'
                  )}
            </p>
            <p>
              {result.relay
                ? t('settings.customRelay.relaySuccess', 'Relay director: connected')
                : t('settings.customRelay.relayFailure', 'Relay director: connection failed')}
            </p>
          </>
        ) : null}
        {server.edited && !server.valid ? (
          <p className="text-destructive">
            {t(
              'settings.customRelay.invalid',
              'Enter valid server URLs and a client ID before continuing.'
            )}
          </p>
        ) : null}
        {error && !server.pending ? (
          <p className="text-destructive">
            {t(
              'settings.customRelay.error',
              'Could not complete the request. Check the server settings and try again.'
            )}
          </p>
        ) : null}
      </div>
    </div>
  )
}
