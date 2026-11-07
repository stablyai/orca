import { useEffect, useRef, useState } from 'react'
import { Badge } from '../../../ui/badge'
import { translate } from '../../../../i18n/i18n'
import { useAppStore } from '../../../../store/index'
import { useOrcaProfileAuthStatusRefresh } from '@/hooks/use-orca-profile-auth-status-refresh'
import { cn } from '@/lib/utils'
import type {
  MobileRelayStatus,
  MobileRelayStatusDetail
} from '../../../../../../shared/remote-runtime/relay/mobile-relay-status'
import type { MobilePairingConnectionMode } from '../../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import { MobilePairingPathOption } from './MobilePairingPathOption'
import { MobileRelaySignInPanel } from './MobileRelaySignInPanel'
import { MobileIrohRelaySettingField } from './MobileIrohRelaySettingField'
import { relayClockSkewMessage } from '../../../mobile/relay-clock-skew-message'

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

// Show the landed Relay cell for support; the scheme offers no actionable detail.
function relayCellLabel(cellUrl: string): string | null {
  try {
    return new URL(cellUrl).host || null
  } catch {
    return null
  }
}

/** Presents connection modes with Relay sign-in guidance and Iroh binding availability. */
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
  const irohRelayUrl = useAppStore((state) => state.settings?.mobileIrohRelayUrl ?? null)
  const [relayStatus, setRelayStatus] = useState<MobileRelayStatusDetail>({ status: 'offline' })
  const [irohBound, setIrohBound] = useState(false)
  const signedIn = authStatus?.state === 'connected'
  const reconnectRequired = authStatus?.state === 'reconnect-required'
  // Unconfigured builds have no Relay sign-in endpoint; mark unavailable instead of offering a dead CTA.
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

  // Wrap/focus enabled radios, but leave nested Sign in controls’ arrows untouched.
  /** Calls `onChange` and moves focus only when an enabled alternative mode is found. */
  const handleArrowKeys = (event: React.KeyboardEvent): void => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      return
    }
    const target = event.target
    if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'radio') {
      return
    }
    event.preventDefault()
    const currentIndex = MODE_ORDER.findIndex((mode) => optionRefs.current[mode] === target)
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

  const relayCell = relayStatus.cellUrl ? relayCellLabel(relayStatus.cellUrl) : null

  useOrcaProfileAuthStatusRefresh()

  useEffect(() => {
    let receivedEvent = false
    let active = true
    const apply = (detail: MobileRelayStatusDetail): void => {
      setRelayStatus(detail)
    }
    const unsubscribe = window.api.mobile.onRelayStatusChanged((detail) => {
      receivedEvent = true
      if (active) {
        apply(detail)
      }
    })
    void window.api.mobile
      .getRelayStatus()
      .then((detail) => {
        if (active && !receivedEvent) {
          apply(detail)
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
    let checking = false
    setIrohBound(false)
    // A relay save replaces the endpoint; restart observation even after an earlier successful bind.
    const check = (): void => {
      if (checking) {
        return
      }
      checking = true
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
        .finally(() => {
          checking = false
        })
    }
    const interval = window.setInterval(check, 3000)
    check()
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [irohRelayUrl])

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
                    : relayStatusLabel(relayStatus.status)}
              </Badge>
            ) : null
          }
        />
        {needsSignIn ? <MobileRelaySignInPanel reconnectRequired={reconnectRequired} /> : null}
        {signedIn &&
        value === 'automatic' &&
        !relayMintFailed &&
        relayStatus.clockOffsetMs !== undefined ? (
          <p className="border-t border-border/60 px-3 py-2 text-xs text-destructive" role="alert">
            {relayClockSkewMessage(relayStatus.clockOffsetMs)}
          </p>
        ) : null}
        {value === 'automatic' && relayCell ? (
          <p
            className="border-t border-border/60 py-2 pl-10 pr-3 text-xs text-muted-foreground"
            data-testid="relay-cell-line"
          >
            {translate(
              'auto.components.settings.MobilePairingConnectionOptions.relayCell',
              'Relay cell'
            )}
            {`: ${relayCell}`}
          </p>
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
                  'Transport is unavailable. Choose another home relay or check logs.'
                )
              : translate(
                  'auto.components.settings.MobilePairingConnectionOptions.irohDescription',
                  'Phone can be on cellular or any Wi‑Fi. No sign-in, no address setup. Direct P2P (hole-punched) with configured home-relay fallback.'
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
      <MobileIrohRelaySettingField />
    </div>
  )
}
