import { useEffect, useState } from 'react'
import { Cloud, Loader2 } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { translate } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import type { MobileRelayStatus } from '../../../../shared/mobile-relay-status'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import { MobileRelayBetaAvailability } from './MobileRelayBetaAvailability'
import { SettingsRow, SettingsSwitch } from './SettingsFormControls'

function relayStatusLabel(status: MobileRelayStatus): string {
  if (status === 'registered') {
    return translate('auto.components.settings.MobilePairingConnectionOptions.ready', 'Ready')
  }
  if (status === 'connecting') {
    return translate(
      'auto.components.settings.MobilePairingConnectionOptions.connecting',
      'Connecting'
    )
  }
  if (status === 'standby') {
    return translate(
      'auto.components.settings.MobilePairingConnectionOptions.available',
      'Available'
    )
  }
  if (status === 'draining') {
    return translate(
      'auto.components.settings.MobilePairingConnectionOptions.reconnecting',
      'Reconnecting'
    )
  }
  return translate(
    'auto.components.settings.MobilePairingConnectionOptions.unavailable',
    'Unavailable'
  )
}

type CompactConnectionOptionsProps = {
  value: MobilePairingConnectionMode
  onChange: (value: MobilePairingConnectionMode) => void
  signedIn: boolean
  configured: boolean
  connecting: boolean
  connect: () => Promise<unknown>
  relayStatus: MobileRelayStatus
}

function ConnectionModeSwitch({
  value,
  onChange,
  signedIn,
  relayStatus,
  showStatus = true
}: Pick<CompactConnectionOptionsProps, 'value' | 'onChange' | 'signedIn' | 'relayStatus'> & {
  showStatus?: boolean
}): React.JSX.Element {
  return (
    <SettingsRow
      label={
        <span className="inline-flex items-center gap-2">
          <Cloud className="size-4 text-muted-foreground" />
          <span>
            {translate(
              'auto.components.settings.MobilePairingConnectionOptions.anywhere',
              'Connect with Orca Relay'
            )}
          </span>
        </span>
      }
      description={
        <span className="block space-y-0.5">
          <span className="block">
            {signedIn
              ? translate(
                  'auto.components.settings.MobilePairingConnectionOptions.automaticDescription',
                  'Orca uses a direct connection when available and Relay otherwise.'
                )
              : translate(
                  'auto.components.settings.MobilePairingConnectionOptions.signInDescription',
                  'Sign in on this desktop to use Orca Relay.'
                )}
          </span>
          <MobileRelayBetaAvailability />
        </span>
      }
      alignTop
      control={
        <div className="flex items-center gap-2">
          {showStatus && signedIn && value === 'automatic' ? (
            <Badge variant="outline" className="shrink-0">
              {relayStatusLabel(relayStatus)}
            </Badge>
          ) : null}
          <SettingsSwitch
            checked={value === 'automatic'}
            disabled={!signedIn}
            ariaLabel={translate(
              'auto.components.settings.MobilePairingConnectionOptions.anywhere',
              'Connect with Orca Relay'
            )}
            onChange={() => onChange(value === 'automatic' ? 'local-only' : 'automatic')}
          />
        </div>
      }
    />
  )
}

function CompactConnectionOptions({
  value,
  onChange,
  signedIn,
  configured,
  connecting,
  connect,
  relayStatus
}: CompactConnectionOptionsProps): React.JSX.Element {
  return (
    <section className="w-full">
      <ConnectionModeSwitch
        value={value}
        onChange={onChange}
        signedIn={signedIn}
        relayStatus={relayStatus}
        showStatus={false}
      />
      {!signedIn ? (
        <div className="flex justify-start">
          {configured ? (
            <Button
              type="button"
              size="xs"
              className="shrink-0"
              disabled={connecting}
              onClick={() => void connect()}
            >
              {connecting ? <Loader2 className="animate-spin" /> : null}
              {translate(
                'auto.components.settings.MobilePairingConnectionOptions.signIn',
                'Sign in'
              )}
            </Button>
          ) : (
            <Badge variant="outline" className="shrink-0">
              {translate(
                'auto.components.settings.MobilePairingConnectionOptions.unavailable',
                'Unavailable'
              )}
            </Badge>
          )}
        </div>
      ) : null}
    </section>
  )
}

export function MobilePairingConnectionOptions({
  value,
  onChange,
  compact = false
}: {
  value: MobilePairingConnectionMode
  onChange: (value: MobilePairingConnectionMode) => void
  compact?: boolean
}): React.JSX.Element {
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

  if (compact) {
    return (
      <CompactConnectionOptions
        value={value}
        onChange={onChange}
        signedIn={signedIn}
        configured={configured}
        connecting={connecting}
        connect={connect}
        relayStatus={relayStatus}
      />
    )
  }

  return (
    <section>
      <ConnectionModeSwitch
        value={value}
        onChange={onChange}
        signedIn={signedIn}
        relayStatus={relayStatus}
      />
      {!signedIn ? (
        <div className="flex justify-end">
          {configured ? (
            <Button
              type="button"
              size="sm"
              className="w-24 shrink-0"
              disabled={connecting}
              onClick={() => void connect()}
            >
              {connecting ? <Loader2 className="animate-spin" /> : null}
              {translate(
                'auto.components.settings.MobilePairingConnectionOptions.signIn',
                'Sign in'
              )}
            </Button>
          ) : (
            <Badge variant="outline" className="shrink-0">
              {translate(
                'auto.components.settings.MobilePairingConnectionOptions.unavailable',
                'Unavailable'
              )}
            </Badge>
          )}
        </div>
      ) : null}
    </section>
  )
}
