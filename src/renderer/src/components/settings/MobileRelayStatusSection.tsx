import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { translate } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import type { MobileRelayStatus } from '../../../../shared/mobile-relay-status'

function relayStatusLabel(status: MobileRelayStatus): string {
  if (status === 'registered') {
    return translate('auto.components.settings.MobileRelayStatusSection.registered', 'Registered')
  }
  if (status === 'connecting') {
    return translate('auto.components.settings.MobileRelayStatusSection.connecting', 'Connecting')
  }
  if (status === 'draining') {
    return translate(
      'auto.components.settings.MobileRelayStatusSection.reconnecting',
      'Reconnecting'
    )
  }
  return translate('auto.components.settings.MobileRelayStatusSection.offline', 'Offline')
}

export function MobileRelayStatusSection(): React.JSX.Element {
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const connecting = useAppStore((state) => state.orcaProfileConnecting)
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  const [relayStatus, setRelayStatus] = useState<MobileRelayStatus>('offline')
  const signedIn = authStatus?.state === 'connected'
  const configured = authStatus?.configured !== false

  useEffect(() => {
    let receivedEvent = false
    let active = true
    const unsubscribe = window.api.mobile.onRelayStatusChanged((status) => {
      receivedEvent = true
      if (active) {
        setRelayStatus(status)
      }
    })
    void window.api.mobile
      .getRelayStatus()
      .then(({ status }) => {
        if (active && !receivedEvent) {
          setRelayStatus(status)
        }
      })
      .catch(() => {})
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">
        {translate('auto.components.settings.MobileRelayStatusSection.title', 'Orca Relay')}
      </h3>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 px-3 py-2.5">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">
            {signedIn
              ? translate(
                  'auto.components.settings.MobileRelayStatusSection.automatic',
                  'Connect from anywhere automatically'
                )
              : translate(
                  'auto.components.settings.MobileRelayStatusSection.signInPrompt',
                  'Sign in on this desktop to connect from anywhere'
                )}
          </p>
          <p className="text-xs text-muted-foreground">
            {signedIn
              ? translate(
                  'auto.components.settings.MobileRelayStatusSection.directStillAvailable',
                  'LAN and Tailscale connections remain available.'
                )
              : translate(
                  'auto.components.settings.MobileRelayStatusSection.directNeedsNoAccount',
                  'LAN and Tailscale pairing still work without an account.'
                )}
          </p>
        </div>
        {signedIn ? (
          <Badge variant="outline" className="shrink-0">
            {relayStatusLabel(relayStatus)}
          </Badge>
        ) : configured ? (
          <Button
            type="button"
            size="sm"
            className="w-24 shrink-0"
            disabled={connecting}
            onClick={() => void connect()}
          >
            {connecting ? <Loader2 className="animate-spin" /> : null}
            {translate('auto.components.settings.MobileRelayStatusSection.signIn', 'Sign in')}
          </Button>
        ) : (
          <Badge variant="outline" className="shrink-0">
            {translate(
              'auto.components.settings.MobileRelayStatusSection.unavailable',
              'Unavailable'
            )}
          </Badge>
        )}
      </div>
    </section>
  )
}
