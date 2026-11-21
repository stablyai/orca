import { useRef, useState } from 'react'
import { Badge } from '../../ui/badge'
import { translate } from '../../../i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '../../../store/index'
import { useOrcaProfileAuthStatusRefresh } from '@/components/orca-profiles/use-orca-profile-auth-status-refresh'
import { cn } from '@/lib/class-names'
import type { MobileRelayStatus } from '../../../../../shared/remote-runtime/relay/mobile-relay-status'
import type { MobilePairingConnectionMode } from '../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import { MobilePairingPathOption } from './MobilePairingPathOption'
import { MobileRelaySignInPanel } from './MobileRelaySignInPanel'
import { MobileCustomRelayFields } from './MobileCustomRelayFields'
import { MobileRelayServerSwitchDialog } from './MobileRelayServerSwitchDialog'
import { useCustomRelayServer } from './use-custom-relay-server'
import { relayClockSkewMessage } from '../relay-clock-skew-message'
import { useMobileRelayStatus } from '../use-mobile-relay-status'
import { Button } from '../../ui/button'

function relayStatusLabel(status: MobileRelayStatus, t: Translate = translate): string {
  if (status === 'registered') {
    return t('auto.components.settings.MobilePairingConnectionOptions.ready', 'Ready')
  }
  if (status === 'connecting') {
    return t('auto.components.settings.MobilePairingConnectionOptions.connecting', 'Connecting')
  }
  if (status === 'standby') {
    return t('auto.components.settings.MobilePairingConnectionOptions.available', 'Available')
  }
  if (status === 'draining') {
    return t('auto.components.settings.MobilePairingConnectionOptions.reconnecting', 'Reconnecting')
  }
  return t('auto.components.settings.MobilePairingConnectionOptions.unavailable', 'Unavailable')
}

// Show the landed Relay cell for support; the scheme offers no actionable detail.
function relayCellLabel(cellUrl: string): string | null {
  try {
    return new URL(cellUrl).host || null
  } catch {
    return null
  }
}

type ConnectionChoice = 'orca-relay' | 'own-relay' | 'lan'
const CONNECTION_CHOICES: readonly ConnectionChoice[] = ['orca-relay', 'own-relay', 'lan']

export function MobilePairingConnectionOptions({
  value,
  onChange,
  compact = false,
  relayMintFailed = false,
  relayMintRetrying = false,
  id
}: {
  value: MobilePairingConnectionMode
  onChange: (value: MobilePairingConnectionMode) => void
  compact?: boolean
  /** When true, show Unavailable on the Relay row (mint failed; no QR). */
  relayMintFailed?: boolean
  relayMintRetrying?: boolean
  id?: string
}): React.JSX.Element {
  const t = useTranslate()
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const relayStatus = useMobileRelayStatus()
  const signedIn = authStatus?.state === 'connected'
  const reconnectRequired = authStatus?.state === 'reconnect-required'
  // Unconfigured builds have no Relay sign-in endpoint; mark unavailable instead of offering a dead CTA.
  const configured = authStatus?.configured !== false
  const server = useCustomRelayServer({ connectionMode: value, onConnectionModeChange: onChange })
  const ownActive = server.active
  // Picking "Your own relay" only reveals its fields; nothing switches until the user applies.
  const [ownDraftOpen, setOwnDraftOpen] = useState(false)
  const choice: ConnectionChoice = ownDraftOpen
    ? 'own-relay'
    : value === 'local-only'
      ? 'lan'
      : ownActive
        ? 'own-relay'
        : 'orca-relay'
  // Relay status belongs to whichever relay server is active, and only while a relay is selected.
  const statusRow: 'orca-relay' | 'own-relay' | null =
    value === 'automatic' && !ownDraftOpen ? (ownActive ? 'own-relay' : 'orca-relay') : null
  const needsSignIn = statusRow !== null && !signedIn && configured
  // Availability is a property of the active server, not of the current selection.
  const relayUnavailable = !signedIn && !configured
  const choiceDisabled: Record<ConnectionChoice, boolean> = {
    'orca-relay': relayMintRetrying || (relayUnavailable && !ownActive),
    // Stays selectable when unconfigured so invalid saved settings can be fixed.
    'own-relay': relayMintRetrying,
    lan: false
  }
  const focusableChoice = choiceDisabled[choice]
    ? (CONNECTION_CHOICES.find((candidate) => !choiceDisabled[candidate]) ?? choice)
    : choice
  const optionRefs = useRef<Record<ConnectionChoice, HTMLDivElement | null>>({
    'orca-relay': null,
    'own-relay': null,
    lan: null
  })

  const openServerSettings = (): void => {
    const state = useAppStore.getState()
    state.openSettingsTarget({ pane: 'mobile', repoId: null })
    state.openSettingsPage()
  }

  const select = (next: ConnectionChoice): void => {
    if (next === 'lan') {
      setOwnDraftOpen(false)
      onChange('local-only')
    } else if (next === 'orca-relay') {
      setOwnDraftOpen(false)
      if (ownActive) {
        // Leaving a custom server signs out, so it needs the same confirmation as switching to one.
        server.requestSwitchToOrcaRelay()
      } else {
        onChange('automatic')
      }
    } else if (ownActive) {
      setOwnDraftOpen(false)
      onChange('automatic')
    } else if (compact) {
      // The setup form is too large for the Mobile page; the Settings pane hosts it.
      openServerSettings()
    } else {
      setOwnDraftOpen(true)
    }
  }

  // Wrap/focus radio arrow navigation, but leave nested Sign in controls’ arrows untouched.
  const handleArrowKeys = (event: React.KeyboardEvent): void => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      return
    }
    const target = event.target
    if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'radio') {
      return
    }
    const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1
    const from = CONNECTION_CHOICES.find((candidate) => optionRefs.current[candidate] === target)
    let index = CONNECTION_CHOICES.indexOf(from ?? choice)
    let next: ConnectionChoice | null = null
    for (let tried = 0; tried < CONNECTION_CHOICES.length && next === null; tried += 1) {
      index = (index + step + CONNECTION_CHOICES.length) % CONNECTION_CHOICES.length
      const candidate = CONNECTION_CHOICES[index]
      next = candidate !== from && !choiceDisabled[candidate] ? candidate : null
    }
    if (next === null) {
      return
    }
    event.preventDefault()
    // Arrows only move focus onto a choice that would open a dialog or leave the page; Space/Enter selects it.
    const selectsWithSideEffect =
      (next === 'orca-relay' && ownActive) || (next === 'own-relay' && compact && !ownActive)
    if (!selectsWithSideEffect) {
      select(next)
    }
    optionRefs.current[next]?.focus()
  }

  const relayCell = relayStatus.cellUrl ? relayCellLabel(relayStatus.cellUrl) : null

  useOrcaProfileAuthStatusRefresh()

  const relayBadge = (row: 'orca-relay' | 'own-relay'): React.ReactNode => {
    if (relayUnavailable && (row === 'own-relay') === ownActive) {
      return (
        <Badge variant="outline" className="text-[11px]">
          {t('auto.components.settings.MobilePairingConnectionOptions.unavailable', 'Unavailable')}
        </Badge>
      )
    }
    if (signedIn && statusRow === row) {
      return (
        <Badge variant="outline" className="text-[11px]">
          {relayMintRetrying
            ? t('auto.components.settings.MobilePairingConnectionOptions.retrying', 'Retrying')
            : relayMintFailed
              ? t(
                  'auto.components.settings.MobilePairingConnectionOptions.unavailable',
                  'Unavailable'
                )
              : relayStatusLabel(relayStatus.status, t)}
        </Badge>
      )
    }
    return null
  }

  // Sign-in, clock-skew and cell lines sit under the relay row whose server is active.
  const relayStatusPanels = (row: 'orca-relay' | 'own-relay'): React.ReactNode =>
    statusRow !== row ? null : (
      <>
        {needsSignIn ? (
          <MobileRelaySignInPanel
            reconnectRequired={reconnectRequired}
            ownServer={row === 'own-relay'}
          />
        ) : null}
        {signedIn && !relayMintFailed && relayStatus.clockOffsetMs !== undefined ? (
          <p className="border-t border-border/60 px-3 py-2 text-xs text-destructive" role="alert">
            {relayClockSkewMessage(relayStatus.clockOffsetMs, t)}
          </p>
        ) : null}
        {relayCell ? (
          <p
            className="border-t border-border/60 py-2 pl-10 pr-3 text-xs text-muted-foreground"
            data-testid="relay-cell-line"
          >
            {t('auto.components.settings.MobilePairingConnectionOptions.relayCell', 'Relay cell')}
            {`: ${relayCell}`}
          </p>
        ) : null}
      </>
    )

  const ownRelayHost = server.saved ? relayCellLabel(server.saved.relayDirectorUrl) : null
  const ownRelayDescription =
    compact && !ownActive
      ? t(
          'auto.components.settings.MobilePairingConnectionOptions.ownRelaySetup',
          'Set up a relay and sign-in service you run in Settings.'
        )
      : relayUnavailable && ownActive
        ? t(
            'auto.components.settings.MobilePairingConnectionOptions.ownRelayUnavailable',
            'The saved server settings are invalid. Update them below.'
          )
        : t(
            'auto.components.settings.MobilePairingConnectionOptions.ownRelayDescription',
            'Use a relay and sign-in service you run. Phone can be on cellular or any Wi‑Fi.'
          )

  return (
    <div id={id} className={cn('space-y-2', compact && 'space-y-1.5')}>
      <div
        role="radiogroup"
        aria-label={t(
          'auto.components.settings.MobilePairingConnectionOptions.pathGroup',
          'How the phone reaches this computer'
        )}
        onKeyDown={handleArrowKeys}
        className="overflow-hidden rounded-md border border-border"
      >
        <MobilePairingPathOption
          selected={choice === 'orca-relay'}
          tabIndex={focusableChoice === 'orca-relay' ? 0 : -1}
          disabled={choiceDisabled['orca-relay']}
          positionInSet={1}
          setSize={3}
          optionRef={(el) => {
            optionRefs.current['orca-relay'] = el
          }}
          onSelect={() => select('orca-relay')}
          title={t(
            'auto.components.settings.MobilePairingConnectionOptions.anywhereTitle',
            'Orca Relay'
          )}
          description={
            relayUnavailable && !ownActive
              ? t(
                  'auto.components.settings.MobilePairingConnectionOptions.relayUnavailable',
                  'Orca Relay isn’t available in this build. Use LAN.'
                )
              : t(
                  'auto.components.settings.MobilePairingConnectionOptions.anywhereDescription',
                  'Phone can be on cellular or any Wi‑Fi. Sign-in required for Relay only.'
                )
          }
          trailing={relayBadge('orca-relay')}
        />
        {relayStatusPanels('orca-relay')}
        <div className="border-t border-border" />
        <MobilePairingPathOption
          selected={choice === 'own-relay'}
          tabIndex={focusableChoice === 'own-relay' ? 0 : -1}
          disabled={choiceDisabled['own-relay']}
          positionInSet={2}
          setSize={3}
          optionRef={(el) => {
            optionRefs.current['own-relay'] = el
          }}
          onSelect={() => select('own-relay')}
          title={t(
            'auto.components.settings.MobilePairingConnectionOptions.ownRelayTitle',
            'Your own relay'
          )}
          description={ownRelayDescription}
          trailing={relayBadge('own-relay')}
        />
        {relayStatusPanels('own-relay')}
        {compact && choice === 'own-relay' && ownActive ? (
          <div
            className="flex items-center justify-between gap-3 border-t border-border/60 py-2 pl-10 pr-3"
            data-testid="own-relay-server-line"
          >
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              {t(
                'auto.components.settings.MobilePairingConnectionOptions.ownRelayServer',
                'Server'
              )}
              {ownRelayHost ? `: ${ownRelayHost}` : ''}
            </p>
            <Button
              variant="link"
              size="inlineText"
              className="shrink-0"
              onClick={openServerSettings}
            >
              {t(
                'auto.components.settings.MobilePairingConnectionOptions.ownRelayServerSettings',
                'Server settings'
              )}
            </Button>
          </div>
        ) : null}
        {!compact && choice === 'own-relay' ? (
          <MobileCustomRelayFields
            server={server}
            onApply={() => {
              if (server.valid) {
                server.requestSwitch(server.valid)
              }
            }}
          />
        ) : null}
        <div className="border-t border-border" />
        <MobilePairingPathOption
          selected={choice === 'lan'}
          tabIndex={focusableChoice === 'lan' ? 0 : -1}
          positionInSet={3}
          setSize={3}
          optionRef={(el) => {
            optionRefs.current.lan = el
          }}
          onSelect={() => select('lan')}
          title={t('auto.components.settings.MobilePairingConnectionOptions.localTitle', 'LAN')}
          description={t(
            'auto.components.settings.MobilePairingConnectionOptions.localDescription',
            'Phone must be on this Wi‑Fi or connected through Tailscale. No account needed.'
          )}
        />
      </div>
      <MobileRelayServerSwitchDialog
        open={server.pending !== null}
        busy={server.busy === 'save'}
        error={server.error}
        onConfirm={() =>
          void server.confirmSwitch().then((switched) => {
            if (switched) {
              setOwnDraftOpen(false)
            }
          })
        }
        onCancel={() => {
          if (server.busy === 'save') {
            return
          }
          server.cancelSwitch()
          // Cancelling the first switch to a custom server returns to the choice that was in effect.
          if (!ownActive) {
            setOwnDraftOpen(false)
          }
        }}
      />
    </div>
  )
}
