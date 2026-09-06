import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { translate } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import { useOrcaProfileAuthStatusRefresh } from '@/hooks/use-orca-profile-auth-status-refresh'
import { cn } from '@/lib/utils'
import type { MobileRelayStatus } from '../../../../shared/mobile-relay-status'
import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import { MobilePairingPathOption } from './MobilePairingPathOption'

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

const MODE_ORDER: MobilePairingConnectionMode[] = ['automatic', 'local-only', 'iroh']

export function MobilePairingConnectionOptions({
  value,
  onChange,
  compact = false,
  relayMintFailed = false,
  relayMintRetrying = false
}: {
  value: MobilePairingConnectionMode
  onChange: (value: MobilePairingConnectionMode) => void
  compact?: boolean
  /** When true, show Unavailable on the Relay row (mint failed; no QR). */
  relayMintFailed?: boolean
  relayMintRetrying?: boolean
}): React.JSX.Element {
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const connecting = useAppStore((state) => state.orcaProfileConnecting)
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  const [relayStatus, setRelayStatus] = useState<MobileRelayStatus>('offline')
  const [irohBound, setIrohBound] = useState(false)
  const signedIn = authStatus?.state === 'connected'
  const reconnectRequired = authStatus?.state === 'reconnect-required'
  // Why: an unconfigured build has no Relay endpoint to sign into, so a Sign in
  // CTA would be dead. Treat that case as unavailable (matching the prior UI)
  // and only offer Sign in when the build can actually reach Relay.
  const configured = authStatus?.configured !== false
  const needsSignIn = value === 'automatic' && !signedIn && configured
  // Availability is a property of the build, not of the current selection.
  const relayUnavailable = !signedIn && !configured
  const relayDisabled = relayMintRetrying || relayUnavailable
  // Why: iroh is a default transport; the option only greys out if the endpoint failed to bind.
  const irohDisabled = !irohBound
  const optionRefs = useRef<Record<MobilePairingConnectionMode, HTMLDivElement | null>>({
    automatic: null,
    'local-only': null,
    iroh: null
  })
  const modeDisabled = (mode: MobilePairingConnectionMode): boolean =>
    (mode === 'automatic' && relayDisabled) || (mode === 'iroh' && irohDisabled)
  // Why: roving tabindex needs exactly one stop — hand it to the first reachable
  // row when the selected path is unavailable in this build.
  const focusableMode = modeDisabled(value)
    ? (MODE_ORDER.find((mode) => !modeDisabled(mode)) ?? 'local-only')
    : value

  // Why: ARIA radiogroups move selection with the arrow keys; wrap between the
  // options, skipping disabled ones, and move focus for standard behavior.
  // Ignore arrows that originate on nested controls (Sign in) so they do not
  // steal keys from the button or flip the path while focus is outside a radio.
  const handleArrowKeys = (event: React.KeyboardEvent): void => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      return
    }
    const target = event.target
    if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'radio') {
      return
    }
    event.preventDefault()
    const currentIndex = Math.max(0, MODE_ORDER.indexOf(value))
    const delta = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1
    for (let step = 1; step < MODE_ORDER.length; step++) {
      const raw = (currentIndex + delta * step) % MODE_ORDER.length
      const next = MODE_ORDER[(raw + MODE_ORDER.length) % MODE_ORDER.length]!
      if (modeDisabled(next)) {
        continue
      }
      onChange(next)
      optionRefs.current[next]?.focus()
      return
    }
  }

  useOrcaProfileAuthStatusRefresh()

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

  useEffect(() => {
    let active = true
    // Why: iroh may still be binding when Settings opens — poll until bound so
    // the option doesn't stay "Unavailable" for the lifetime of the pane.
    const check = (): void => {
      void window.api.mobile
        .getIrohStatus()
        .then((status) => {
          if (active) {
            setIrohBound(status.bound)
            if (status.bound) {
              window.clearInterval(interval)
            }
          }
        })
        .catch(() => {
          if (active) {
            setIrohBound(false)
          }
        })
    }
    const interval = window.setInterval(check, 3000)
    check()
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [])

  return (
    <div className={cn('space-y-2', compact && 'space-y-1.5')}>
      <div
        role="radiogroup"
        aria-label={translate(
          'auto.components.settings.MobilePairingConnectionOptions.pathGroup',
          'How the phone reaches this computer'
        )}
        onKeyDown={handleArrowKeys}
        className="overflow-hidden rounded-md border border-border"
      >
        <MobilePairingPathOption
          selected={value === 'automatic'}
          tabIndex={focusableMode === 'automatic' ? 0 : -1}
          disabled={relayDisabled}
          positionInSet={1}
          setSize={3}
          optionRef={(el) => {
            optionRefs.current.automatic = el
          }}
          onSelect={() => onChange('automatic')}
          title={translate(
            'auto.components.settings.MobilePairingConnectionOptions.anywhereTitle',
            'Orca Relay'
          )}
          description={
            relayUnavailable
              ? translate(
                  'auto.components.settings.MobilePairingConnectionOptions.relayUnavailable',
                  'Orca Relay isn’t available in this build. Use LAN.'
                )
              : translate(
                  'auto.components.settings.MobilePairingConnectionOptions.anywhereDescription',
                  'Phone can be on cellular or any Wi‑Fi. Sign-in required for Relay only.'
                )
          }
          trailing={
            relayUnavailable ? (
              <Badge variant="outline" className="text-[11px]">
                {translate(
                  'auto.components.settings.MobilePairingConnectionOptions.unavailable',
                  'Unavailable'
                )}
              </Badge>
            ) : signedIn && value === 'automatic' ? (
              <Badge variant="outline" className="text-[11px]">
                {relayMintRetrying
                  ? translate(
                      'auto.components.settings.MobilePairingConnectionOptions.retrying',
                      'Retrying'
                    )
                  : relayMintFailed
                    ? translate(
                        'auto.components.settings.MobilePairingConnectionOptions.unavailable',
                        'Unavailable'
                      )
                    : relayStatusLabel(relayStatus)}
              </Badge>
            ) : null
          }
        />
        {needsSignIn ? (
          <div
            // Why: indent under the Relay radio so Sign in reads as a Relay
            // sub-step, not a requirement for the whole connection section/LAN.
            // Deliberately role-less: a `group` here would be an invalid owned
            // element of the radiogroup, and its label would double-announce the
            // button it wraps. The plain div contributes nothing to the a11y
            // tree, leaving the CTA reachable by Tab as an ordinary button.
            onKeyDown={(event) => {
              // Why: nested controls live inside the radiogroup for layout; do not
              // let arrow keys bubble and flip the selected path.
              if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
                event.stopPropagation()
              }
            }}
            className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-accent/40 py-2.5 pl-10 pr-3"
            data-testid="anywhere-sign-in-panel"
          >
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.MobilePairingConnectionOptions.signInRequired',
                'Relay only — LAN does not need an account.'
              )}
            </p>
            <Button
              type="button"
              size="sm"
              className="shrink-0"
              disabled={connecting}
              onClick={() => {
                onChange('automatic')
                void connect()
              }}
            >
              {connecting ? <Loader2 className="animate-spin" /> : null}
              {reconnectRequired
                ? translate(
                    'auto.components.settings.MobilePairingConnectionOptions.signInAgain',
                    'Sign in again for Relay'
                  )
                : translate(
                    'auto.components.settings.MobilePairingConnectionOptions.signIn',
                    'Sign in for Relay'
                  )}
            </Button>
          </div>
        ) : null}
        <div className="border-t border-border" />
        <MobilePairingPathOption
          selected={value === 'local-only'}
          tabIndex={focusableMode === 'local-only' ? 0 : -1}
          positionInSet={2}
          setSize={3}
          optionRef={(el) => {
            optionRefs.current['local-only'] = el
          }}
          onSelect={() => onChange('local-only')}
          title={translate(
            'auto.components.settings.MobilePairingConnectionOptions.localTitle',
            'LAN'
          )}
          description={translate(
            'auto.components.settings.MobilePairingConnectionOptions.localDescription',
            'Phone must be on this Wi‑Fi or connected through Tailscale. No account needed.'
          )}
        />
        <div className="border-t border-border" />
        <MobilePairingPathOption
          selected={value === 'iroh'}
          tabIndex={focusableMode === 'iroh' ? 0 : -1}
          disabled={irohDisabled}
          positionInSet={3}
          setSize={3}
          optionRef={(el) => {
            optionRefs.current.iroh = el
          }}
          onSelect={() => onChange('iroh')}
          title={translate(
            'auto.components.settings.MobilePairingConnectionOptions.irohTitle',
            'Iroh'
          )}
          description={
            irohDisabled
              ? translate(
                  'auto.components.settings.MobilePairingConnectionOptions.irohUnavailable',
                  'Transport failed to bind. Restart Orca, or check logs.'
                )
              : translate(
                  'auto.components.settings.MobilePairingConnectionOptions.irohDescription',
                  'Phone can be on cellular or any Wi‑Fi. No sign-in, no address setup. Direct P2P (hole-punched) with public relay fallback.'
                )
          }
          trailing={
            irohDisabled ? (
              <Badge variant="outline" className="text-[11px]">
                {translate(
                  'auto.components.settings.MobilePairingConnectionOptions.unavailable',
                  'Unavailable'
                )}
              </Badge>
            ) : null
          }
        />
      </div>
    </div>
  )
}
