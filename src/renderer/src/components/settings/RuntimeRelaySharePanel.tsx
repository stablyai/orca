import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { Button } from '../ui/button'
import { useAppStore } from '../../store'
import { useOrcaProfileAuthStatusRefresh } from '@/hooks/use-orca-profile-auth-status-refresh'
import { translate } from '@/i18n/i18n'

export function isRuntimeRelayShareReady(authStatus: OrcaProfileAuthStatus | null): boolean {
  return authStatus?.state === 'connected'
}

export function RuntimeRelaySharePanel({
  authStatus
}: {
  authStatus: OrcaProfileAuthStatus | null
}): React.JSX.Element {
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  useOrcaProfileAuthStatusRefresh()
  // Why: an unconfigured build has no Relay to sign into, so a Sign in button would be dead.
  const configured = authStatus?.configured !== false

  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
      <div className="font-medium">
        {translate('auto.components.settings.RuntimeRelaySharePanel.title', 'Orca Relay')}
      </div>
      <p className="text-muted-foreground">
        {!configured
          ? translate(
              'auto.components.settings.RuntimeRelaySharePanel.unavailable',
              'Orca Relay isn’t available in this build. Share over LAN, Tailscale, or a custom address.'
            )
          : isRuntimeRelayShareReady(authStatus)
            ? translate(
                'auto.components.settings.RuntimeRelaySharePanel.ready',
                'The other Orca tries this computer’s LAN or Tailscale address first, then Orca Relay. Traffic stays end-to-end encrypted.'
              )
            : translate(
                'auto.components.settings.RuntimeRelaySharePanel.signInRequired',
                'Sign in to an Orca account to share through Orca Relay.'
              )}
      </p>
      {configured && !isRuntimeRelayShareReady(authStatus) ? (
        <Button type="button" size="sm" onClick={() => void connect()}>
          {authStatus?.state === 'reconnect-required'
            ? translate(
                'auto.components.settings.RuntimeRelaySharePanel.signInAgain',
                'Sign in again for Relay'
              )
            : translate(
                'auto.components.settings.RuntimeRelaySharePanel.signIn',
                'Sign in for Relay'
              )}
        </Button>
      ) : null}
    </div>
  )
}
